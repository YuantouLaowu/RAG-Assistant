import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(description="Run local RAG web app (no extra deps).")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8848)
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args = parser.parse_args()

    # Ensure relative paths in config.py work as expected
    project_root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_root)

    from local_app.server import serve

    serve(host=args.host, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()


