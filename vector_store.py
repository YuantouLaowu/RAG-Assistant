import os
from typing import List, Dict

import chromadb
from chromadb.config import Settings
from openai import OpenAI
from tqdm import tqdm

from config import (
    VECTOR_DB_PATH,
    COLLECTION_NAME,
    OPENAI_API_KEY,
    OPENAI_API_BASE,
    OPENAI_EMBEDDING_MODEL,
    TOP_K,
)


class VectorStore:

    def __init__(
        self,
        db_path: str = VECTOR_DB_PATH,
        collection_name: str = COLLECTION_NAME,
        api_key: str = OPENAI_API_KEY,
        api_base: str = OPENAI_API_BASE,
    ):
        self.db_path = db_path
        self.collection_name = collection_name

        # 初始化OpenAI客户端
        self.client = OpenAI(api_key=api_key, base_url=api_base)

        # 初始化ChromaDB
        os.makedirs(db_path, exist_ok=True)
        self.chroma_client = chromadb.PersistentClient(
            path=db_path, settings=Settings(anonymized_telemetry=False)
        )

        # 获取或创建collection
        self.collection = self.chroma_client.get_or_create_collection(
            name=collection_name, metadata={"description": "课程材料向量数据库"}
        )

    def get_embedding(self, text: str) -> List[float]:
        """获取文本的向量表示

        TODO: 使用OpenAI API获取文本的embedding向量
        """
        text = text.replace("\n", " ")
        response = self.client.embeddings.create(
            input=text,
            model=OPENAI_EMBEDDING_MODEL
        )
        return response.data[0].embedding

    def add_documents(self, chunks: List[Dict[str, str]]) -> None:
        """添加文档块到向量数据库
        TODO: 实现文档块添加到向量数据库
        要求：
        1. 遍历文档块
        2. 获取文档块内容
        3. 获取文档块元数据
        5. 打印添加进度
        """
        ids = []
        documents = []
        metadatas = []
        embeddings = []

        for i, chunk in enumerate(tqdm(chunks, desc="添加文档到向量库", unit="chunk")):
            content = chunk.get("content", "")
            if not content:
                continue
                
            # 准备metadata (移除content字段，处理不支持的类型)
            metadata = chunk.copy()
            if "content" in metadata:
                del metadata["content"]
            
            # 处理images列表，转换为字符串，因为Chroma不支持列表类型的metadata
            if "images" in metadata and isinstance(metadata["images"], list):
                metadata["images"] = str(metadata["images"])
                
            # 生成唯一ID
            # 使用文件名_chunkID_索引作为ID，确保唯一性
            filename = metadata.get("filename", "unknown")
            chunk_id = metadata.get("chunk_id", i)
            doc_id = f"{filename}_{chunk_id}_{i}"
            
            # 获取embedding
            embedding = self.get_embedding(content)
            
            ids.append(doc_id)
            documents.append(content)
            metadatas.append(metadata)
            embeddings.append(embedding)

        # 批量添加到ChromaDB
        if ids:
            self.collection.add(
                ids=ids,
                documents=documents,
                metadatas=metadatas,
                embeddings=embeddings
            )
            print(f"成功添加 {len(ids)} 个文档块到向量数据库")

    def search(self, query: str, top_k: int = TOP_K) -> List[Dict]:
        """搜索相关文档

        TODO: 实现向量相似度搜索
        要求：
        1. 首先获取查询文本的embedding向量（调用self.get_embedding）
        2. 使用self.collection进行向量搜索, 得到top_k个结果
        3. 格式化返回结果，每个结果包含：
           - content: 文档内容
           - metadata: 元数据（文件名、页码等）
        4. 返回格式化的结果列表
        """
        # 1. 获取查询向量
        query_embedding = self.get_embedding(query)
        
        # 2. 搜索
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k
        )
        
        # 3. 格式化结果
        formatted_results = []
        
        # results['documents'] 是列表的列表 (因为可以批量查询)
        if results and results['documents']:
            documents = results['documents'][0]
            metadatas = results['metadatas'][0] if results['metadatas'] else [{}] * len(documents)
            
            for doc, meta in zip(documents, metadatas):
                formatted_results.append({
                    "content": doc,
                    "metadata": meta
                })

        return formatted_results

    def clear_collection(self) -> None:
        """清空collection"""
        self.chroma_client.delete_collection(name=self.collection_name)
        self.collection = self.chroma_client.create_collection(
            name=self.collection_name, metadata={"description": "课程向量数据库"}
        )
        print("向量数据库已清空")

    def get_collection_count(self) -> int:
        """获取collection中的文档数量"""
        return self.collection.count()
