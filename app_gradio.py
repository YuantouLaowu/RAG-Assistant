import gradio as gr
import os
from rag_agent import RAGAgent
from config import MODEL_NAME, VECTOR_DB_PATH

def initialize_agent():
    """初始化RAG Agent"""
    if not os.path.exists(VECTOR_DB_PATH):
        return None, "向量数据库未找到，请先运行数据处理脚本。"
    
    try:
        agent = RAGAgent(model=MODEL_NAME)
        # 检查知识库是否为空
        if agent.vector_store.get_collection_count() == 0:
            return None, "知识库为空，请先添加文档并运行数据处理。"
        return agent, "系统初始化成功"
    except Exception as e:
        return None, f"初始化失败: {str(e)}"

# 全局变量存储agent实例
agent = None

def chat_function(message, history):
    global agent
    
    # 第一次调用时初始化
    if agent is None:
        agent_instance, status_msg = initialize_agent()
        if agent_instance is None:
            return f"系统错误: {status_msg}"
        agent = agent_instance
    
    try:
        # 转换历史格式为 list of dicts
        chat_history = []
        for human_msg, ai_msg in history:
            chat_history.append({"role": "user", "content": human_msg})
            chat_history.append({"role": "assistant", "content": ai_msg})
            
        # 获取回答
        response = agent.answer_question(message, chat_history=chat_history)
        return response
        
    except Exception as e:
        return f"发生错误: {str(e)}"

# 创建Gradio界面
with gr.Blocks(title="智能课程助教", theme=gr.themes.Soft()) as demo:
    gr.Markdown(
        """
        # 🎓 智能课程助教
        基于RAG技术的课程问答助手，可以根据课程资料回答您的问题。
        """
    )
    
    chatbot = gr.ChatInterface(
        fn=chat_function,
        chatbot=gr.Chatbot(height=600, bubble_full_width=False, type="messages"),
        textbox=gr.Textbox(placeholder="请输入您的问题...", container=False, scale=7),
        title=None,
        description="您可以问我关于课程的任何问题",
        theme="soft",
        examples=["这门课主要讲了什么？", "如何进行期末复习？", "课程的重点难点有哪些？"],
        retry_btn="重试",
        undo_btn="撤销",
        clear_btn="清空对话",
    )

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860, share=False)

