import json
import os
import sys
import threading
import time
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = Path(__file__).resolve().parent / "web"


def _json_bytes(data: Any, *, status: int = 200) -> Tuple[int, bytes]:
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    return status, payload


def _read_json_body(handler: BaseHTTPRequestHandler, *, limit: int = 2_000_000) -> Any:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return None
    if length > limit:
        raise ValueError("request too large")
    raw = handler.rfile.read(length)
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def _safe_join(base: Path, requested_path: str) -> Optional[Path]:
    # Prevent path traversal; return None if the resolved path is outside base.
    requested_path = requested_path.lstrip("/")
    resolved = (base / requested_path).resolve()
    try:
        resolved.relative_to(base.resolve())
    except Exception:
        return None
    return resolved


class _RebuildState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running = False
        self.last_started_at: Optional[float] = None
        self.last_finished_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self.logs: List[str] = []
        self.stage: str = "idle"
        self.current: int = 0
        self.total: int = 0

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            percent = 0
            if self.total > 0:
                percent = int(min(100, max(0, (self.current / self.total) * 100)))
            return {
                "running": self.running,
                "last_started_at": self.last_started_at,
                "last_finished_at": self.last_finished_at,
                "last_error": self.last_error,
                "logs_tail": self.logs[-400:],
                "stage": self.stage,
                "current": self.current,
                "total": self.total,
                "percent": percent,
            }

    def append_log(self, line: str) -> None:
        with self.lock:
            self.logs.append(line)
            # cap memory
            if len(self.logs) > 5000:
                self.logs = self.logs[-5000:]

    def set_progress(self, *, stage: str, current: int, total: int) -> None:
        with self.lock:
            self.stage = stage
            self.current = int(current)
            self.total = int(total)


class RagWebApp:
    def __init__(self) -> None:
        self._agent = None
        self._agent_lock = threading.Lock()
        self._rebuild = _RebuildState()

    def _load_agent(self):
        # Lazy import to keep server import-time lightweight and ensure PROJECT_ROOT is set.
        with self._agent_lock:
            if self._agent is not None:
                return self._agent
            sys.path.insert(0, str(PROJECT_ROOT))
            from config import MODEL_NAME  # type: ignore
            from rag_agent import RAGAgent  # type: ignore

            self._agent = RAGAgent(model=MODEL_NAME)
            return self._agent

    def status(self) -> Dict[str, Any]:
        sys.path.insert(0, str(PROJECT_ROOT))
        from config import (  # type: ignore
            DATA_DIR,
            VECTOR_DB_PATH,
            MODEL_NAME,
            OPENAI_API_BASE,
            OPENAI_EMBEDDING_MODEL,
            TOP_K,
            CHUNK_SIZE,
            CHUNK_OVERLAP,
        )

        data_dir = (PROJECT_ROOT / DATA_DIR).resolve() if not os.path.isabs(DATA_DIR) else Path(DATA_DIR)
        vector_db = (PROJECT_ROOT / VECTOR_DB_PATH).resolve() if not os.path.isabs(VECTOR_DB_PATH) else Path(VECTOR_DB_PATH)

        count = None
        count_error = None
        try:
            agent = self._load_agent()
            count = agent.vector_store.get_collection_count()
        except Exception as e:
            count_error = str(e)

        return {
            "project_root": str(PROJECT_ROOT),
            "data_dir": str(data_dir),
            "data_dir_exists": data_dir.exists(),
            "vector_db_path": str(vector_db),
            "vector_db_exists": vector_db.exists(),
            "collection_count": count,
            "collection_count_error": count_error,
            "model": MODEL_NAME,
            "embedding_model": OPENAI_EMBEDDING_MODEL,
            "api_base": OPENAI_API_BASE,
            "defaults": {
                "top_k": TOP_K,
                "chunk_size": CHUNK_SIZE,
                "chunk_overlap": CHUNK_OVERLAP,
            },
            "rebuild": self._rebuild.snapshot(),
        }

    def rebuild_status(self) -> Dict[str, Any]:
        return self._rebuild.snapshot()

    def chat(
        self,
        message: str,
        history: Optional[List[Dict[str, str]]] = None,
        *,
        top_k: int = 3,
        temperature: float = 0.7,
        max_tokens: int = 1500,
        include_context: bool = False,
    ) -> Dict[str, Any]:
        agent = self._load_agent()

        t0 = time.time()
        context, retrieved = agent.retrieve_context(message, top_k=top_k)
        if not context:
            context = "（未检索到特别相关的课程材料）"

        messages: List[Dict[str, Any]] = [{"role": "system", "content": agent.system_prompt}]
        if history:
            # history comes as [{"role":"user|assistant","content":"..."}]
            for item in history:
                role = item.get("role")
                content = item.get("content")
                if role in ("user", "assistant") and isinstance(content, str):
                    messages.append({"role": role, "content": content})

        user_text = f"""请根据以下【课程内容】回答【学生问题】。
【课程内容】
{context}
【学生问题】
{message}"""

        messages.append({"role": "user", "content": user_text})

        answer = agent.client.chat.completions.create(
            model=agent.model,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
        ).choices[0].message.content

        sources = []
        for r in retrieved or []:
            meta = r.get("metadata", {}) or {}
            filename = meta.get("filename", "未知文件")
            page = meta.get("page_number", "N/A")
            sources.append(
                {
                    "filename": filename,
                    "page_number": page,
                    "snippet": (r.get("content", "") or "")[:500],
                }
            )

        out: Dict[str, Any] = {
            "answer": answer,
            "sources": sources,
            "latency_ms": int((time.time() - t0) * 1000),
        }
        if include_context:
            out["context"] = context
        return out

    def rebuild_async(self) -> Dict[str, Any]:
        return self.rebuild_async_with_files(None)

    def rebuild_async_with_files(self, files: Optional[List[str]]) -> Dict[str, Any]:
        with self._rebuild.lock:
            if self._rebuild.running:
                return {"started": False, "message": "重建任务正在运行中"}
            self._rebuild.running = True
            self._rebuild.last_started_at = time.time()
            self._rebuild.last_error = None
            self._rebuild.append_log("== 开始重建知识库 ==")
            self._rebuild.stage = "starting"
            self._rebuild.current = 0
            self._rebuild.total = 0

        def _worker():
            try:
                sys.path.insert(0, str(PROJECT_ROOT))
                # Ensure relative paths in config work as expected
                os.chdir(str(PROJECT_ROOT))

                from config import (  # type: ignore
                    DATA_DIR,
                    CHUNK_SIZE,
                    CHUNK_OVERLAP,
                    VECTOR_DB_PATH,
                )
                from document_loader import DocumentLoader  # type: ignore
                from text_splitter import TextSplitter  # type: ignore
                from vector_store import VectorStore  # type: ignore

                from config import (  # type: ignore
                    COLLECTION_NAME,
                )

                base = (PROJECT_ROOT / DATA_DIR).resolve() if not os.path.isabs(DATA_DIR) else Path(DATA_DIR).resolve()
                if not base.exists():
                    raise RuntimeError(f"data_dir not found: {base}")

                supported = {".pdf", ".pptx", ".docx", ".txt"}
                resolved_files: List[Path] = []
                if files is None:
                    self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 扫描 data/ 文件 ...")
                    all_files = [p for p in sorted(base.rglob("*")) if p.is_file() and p.suffix.lower() in supported]
                    resolved_files = all_files
                else:
                    raise RuntimeError("已移除“选择文档重建”功能：请直接重建 data/ 全部文档")

                if not resolved_files:
                    raise RuntimeError("未找到任何可用文档（data/ 为空或未选择文件）")

                loader = DocumentLoader(data_dir=str(base))
                splitter = TextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
                vector_store = VectorStore(db_path=VECTOR_DB_PATH, collection_name=COLLECTION_NAME)

                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 清空向量库 ...")
                self._rebuild.set_progress(stage="清空向量库", current=0, total=1)
                vector_store.clear_collection()
                self._rebuild.set_progress(stage="清空向量库", current=1, total=1)

                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 加载文档 ...")
                documents = []
                self._rebuild.set_progress(stage="加载文档", current=0, total=len(resolved_files))
                for idx, fp in enumerate(resolved_files, 1):
                    self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 加载: {fp.relative_to(base).as_posix()}")
                    docs = loader.load_document(str(fp))
                    if docs:
                        documents.extend(docs)
                    self._rebuild.set_progress(stage="加载文档", current=idx, total=len(resolved_files))

                if not documents:
                    raise RuntimeError("未找到任何可用文档内容（可能解析失败）")

                # Split with progress (avoid tqdm inside split_documents for better UI progress)
                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 切分文档 ...")
                self._rebuild.set_progress(stage="切分文档", current=0, total=len(documents))
                chunks: List[Dict[str, Any]] = []
                for i, doc in enumerate(documents, 1):
                    content = doc.get("content", "")
                    filetype = doc.get("filetype", "")
                    if filetype in [".pdf", ".pptx"]:
                        chunks.append(
                            {
                                "content": content,
                                "filename": doc.get("filename", "unknown"),
                                "filepath": doc.get("filepath", ""),
                                "filetype": filetype,
                                "page_number": doc.get("page_number", 0),
                                "chunk_id": 0,
                                "images": doc.get("images", []),
                            }
                        )
                    else:
                        parts = splitter.split_text(content)
                        for j, part in enumerate(parts):
                            chunks.append(
                                {
                                    "content": part,
                                    "filename": doc.get("filename", "unknown"),
                                    "filepath": doc.get("filepath", ""),
                                    "filetype": filetype,
                                    "page_number": 0,
                                    "chunk_id": j,
                                    "images": [],
                                }
                            )
                    self._rebuild.set_progress(stage="切分文档", current=i, total=len(documents))
                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 切分完成：共 {len(chunks)} 个块")

                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 生成 embedding 并写入向量库 ...")
                self._rebuild.set_progress(stage="生成 embedding", current=0, total=len(chunks))

                # Build and add in batches to reduce overhead
                batch_size = 32
                ids: List[str] = []
                documents_text: List[str] = []
                metadatas: List[Dict[str, Any]] = []
                embeddings: List[List[float]] = []

                def _flush():
                    if not ids:
                        return
                    vector_store.collection.add(
                        ids=ids,
                        documents=documents_text,
                        metadatas=metadatas,
                        embeddings=embeddings,
                    )
                    ids.clear()
                    documents_text.clear()
                    metadatas.clear()
                    embeddings.clear()

                for idx, chunk in enumerate(chunks, 1):
                    content = chunk.get("content", "")
                    if not content:
                        self._rebuild.set_progress(stage="生成 embedding", current=idx, total=len(chunks))
                        continue

                    metadata = chunk.copy()
                    metadata.pop("content", None)
                    if "images" in metadata and isinstance(metadata["images"], list):
                        metadata["images"] = str(metadata["images"])

                    filename = metadata.get("filename", "unknown")
                    chunk_id = metadata.get("chunk_id", idx)
                    doc_id = f"{filename}_{chunk_id}_{idx}"

                    emb = vector_store.get_embedding(content)
                    ids.append(doc_id)
                    documents_text.append(content)
                    metadatas.append(metadata)
                    embeddings.append(emb)

                    if len(ids) >= batch_size:
                        _flush()

                    if idx % 10 == 0 or idx == len(chunks):
                        self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] embedding: {idx}/{len(chunks)}")
                    self._rebuild.set_progress(stage="生成 embedding", current=idx, total=len(chunks))

                _flush()

                try:
                    self._rebuild.set_progress(stage="校验结果", current=0, total=1)
                    count = vector_store.get_collection_count()
                    self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 向量库文档块数: {count}")
                    if count == 0:
                        raise RuntimeError("写入完成但向量库仍为空（Docs=0）")
                except Exception:
                    raise
                self._rebuild.set_progress(stage="校验结果", current=1, total=1)
                self._rebuild.append_log(f"[{time.strftime('%H:%M:%S')}] 重建完成 ✅")
            except Exception:
                err = traceback.format_exc()
                self._rebuild.append_log(err)
                with self._rebuild.lock:
                    self._rebuild.last_error = err
            finally:
                with self._rebuild.lock:
                    self._rebuild.running = False
                    self._rebuild.last_finished_at = time.time()
                    self._rebuild.stage = "idle"

        threading.Thread(target=_worker, daemon=True).start()
        return {"started": True, "message": "已开始重建（后台执行）"}


APP = RagWebApp()


class Handler(BaseHTTPRequestHandler):
    server_version = "RagLocalApp/1.0"

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            # same-origin by default; no CORS header needed
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Client closed the connection (e.g. user hit "打断", navigation, or browser timeout).
            return
        except OSError as e:
            # Some OSes raise generic OSError for the same condition.
            if getattr(e, "errno", None) in (32, 104):
                return
            raise

    def _send_json(self, data: Any, *, status: int = 200) -> None:
        code, payload = _json_bytes(data, status=status)
        self._send(code, payload, "application/json; charset=utf-8")

    def _send_text(self, text: str, *, status: int = 200) -> None:
        self._send(status, text.encode("utf-8"), "text/plain; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self._send_text("Not found", status=404)
            return
        ext = path.suffix.lower()
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".ico": "image/x-icon",
            ".webp": "image/webp",
        }.get(ext, "application/octet-stream")
        data = path.read_bytes()
        self._send(200, data, content_type)

    def log_message(self, fmt: str, *args) -> None:
        # keep console quiet; comment out if you want full logs
        return

    def do_GET(self) -> None:
        try:
            if self.path == "/" or self.path.startswith("/?"):
                self._send_file(WEB_ROOT / "index.html")
                return

            if self.path.startswith("/assets/"):
                target = _safe_join(WEB_ROOT, self.path.lstrip("/"))
                if target is None:
                    self._send_text("Bad path", status=400)
                    return
                self._send_file(target)
                return

            if self.path == "/api/status":
                self._send_json(APP.status())
                return

            if self.path == "/api/rebuild/status":
                # Important: do NOT call APP.status() here, to avoid blocking on vector DB locks
                self._send_json(APP.rebuild_status())
                return

            self._send_text("Not found", status=404)
        except Exception as e:
            self._send_json({"error": str(e)}, status=500)

    def do_POST(self) -> None:
        try:
            if self.path == "/api/chat":
                body = _read_json_body(self)
                if not isinstance(body, dict):
                    self._send_json({"error": "invalid json body"}, status=400)
                    return

                message = body.get("message", "")
                if not isinstance(message, str) or not message.strip():
                    self._send_json({"error": "message required"}, status=400)
                    return

                history = body.get("history")
                if history is not None and not isinstance(history, list):
                    self._send_json({"error": "history must be a list"}, status=400)
                    return

                resp = APP.chat(
                    message.strip(),
                    history=history,
                    top_k=int(body.get("top_k", 3)),
                    temperature=float(body.get("temperature", 0.7)),
                    max_tokens=int(body.get("max_tokens", 1500)),
                    include_context=bool(body.get("include_context", False)),
                )
                self._send_json(resp)
                return

            if self.path == "/api/rebuild":
                # Rebuild all documents under data/
                self._send_json(APP.rebuild_async_with_files(None))
                return

            if self.path == "/api/ping":
                self._send_json({"ok": True, "ts": time.time()})
                return

            self._send_text("Not found", status=404)
        except Exception as e:
            self._send_json({"error": str(e), "trace": traceback.format_exc()}, status=500)


def serve(*, host: str = "127.0.0.1", port: int = 8848, open_browser: bool = True) -> None:
    os.chdir(str(PROJECT_ROOT))
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    print(f"Local RAG App running at: {url}")
    print(f"Project root: {PROJECT_ROOT}")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    httpd.serve_forever()


