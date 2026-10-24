import os

from groq import Groq


def get_client() -> Groq:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("Set the GROQ_API_KEY environment variable before running this script.")
    return Groq(api_key=api_key)


def chat_with_groq():
    client = get_client()
    conversation_history = [
        {"role": "system", "content": "You are a helpful and concise assistant."}
    ]

    print("Groq Chatbot initialized! Type 'exit' or 'quit' to stop.\n")

    while True:
        user_input = input("You: ").strip()
        user_input = "think well before answering " + user_input
        if user_input.lower() in ("exit", "quit"):
            print("Goodbye!")
            break
        if not user_input:
            continue

        conversation_history.append({"role": "user", "content": user_input})

        try:
            response_stream = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=conversation_history,
                stream=True,
            )

            print("Groq: ", end="", flush=True)
            assistant_reply = ""
            for chunk in response_stream:
                content = chunk.choices[0].delta.content or ""
                assistant_reply += content
                print(content, end="", flush=True)
            print("\n")

            conversation_history.append({"role": "assistant", "content": assistant_reply})

        except Exception as e:
            print(f"\nError: {e}\n")


if __name__ == "__main__":
    chat_with_groq()