## 本地 App（轻量 Web UI）

### 启动

在项目根目录执行：

```bash
python run_local_app.py
```

默认地址：`http://127.0.0.1:8848/`

参数：

- `--host 0.0.0.0`：局域网访问（谨慎）
- `--port 9000`：自定义端口
- `--no-browser`：不自动打开浏览器

### 功能

- 多会话：新增对话 / 会话切换 / 删除会话 / 重命名（保存在浏览器 `localStorage`）
- 聊天：加载提示、打字机输出、可“打断”
- 渲染：Markdown + LaTeX（`$$...$$` / `\\(...\\)`，使用 MathJax）
- 引用：展示本轮来源（文件名/页码 + 片段）
- 重建知识库：一键重建 `data/` 全部文档，带日志与进度条

### 常见问题

- **Docs=0 / 向量库不存在**：先点“重建知识库”，或确认 `./data` 里已有课程文件（PDF/PPTX/DOCX/TXT）。
- **OpenAI/Embedding 报错**：检查 `config.py` 中 `OPENAI_API_KEY` / `OPENAI_API_BASE` / 模型名称是否可用。
- **公式不显示**：MathJax 通过 CDN 加载，需要联网；如需纯离线可再改成本地静态资源。


