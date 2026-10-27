import functools
import http.server
import os
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures"
BRIDGE = ROOT / "src" / "content" / "agent.js"

def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURE_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server

def main():
    server = serve()
    port = server.server_address[1]
    failures = []

    def check(name, condition, detail=""):
        if condition:
            print(f"ok   {name}")
        else:
            failures.append(name)
            print(f"FAIL {name} {detail}")

    with sync_playwright() as p:
        launch = {}
        if os.environ.get("PLAYWRIGHT_CHROMIUM"):
            launch["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM"]
        browser = p.chromium.launch(args=["--no-sandbox"], **launch)
        page = browser.new_page(viewport={"width": 900, "height": 900})
        page.add_init_script(
            "window.browser = { runtime: { id: 'test', onMessage: { addListener(fn) { window.__foxHandle = fn; } } } };"
        )
        page.goto(f"http://127.0.0.1:{port}/page.html")
        page.add_script_tag(path=str(BRIDGE))

        def call(op, args=None):
            return page.evaluate(
                "async ({ op, args }) => await window.__foxHandle({ __foxagent: true, op, args }, { id: 'test' })",
                {"op": op, "args": args or {}},
            )

        def result(op, args=None):
            res = call(op, args)
            if not res.get("ok"):
                raise AssertionError(f"{op} failed: {res.get('error')}")
            return res["result"]

        snap = result("snapshot", {"maxElements": 80})
        joined = "\n".join(snap["elements"])
        check("snapshot sees a normal button", '"Start task"' in joined)
        check("snapshot sees an input placeholder", "you@example.com" in joined)
        check("snapshot sees a shadow DOM button", "Shadow action" in joined)
        check("snapshot sees an iframe field", "Frame field" in joined)
        check("snapshot marks offscreen controls", "offscreen" in joined or len(snap["elements"]) < 12)

        clicked = result("clickText", {"text": "Start task"})
        check("clickText clicks by label", clicked["label"] == "Start task")
        page.wait_for_timeout(100)
        check("click ran the handler", page.inner_text("#out").startswith("started"))

        box = page.locator("#go").bounding_box()
        at = result("clickAt", {"x": int(box["x"] + box["width"] / 2), "y": int(box["y"] + box["height"] / 2)})
        check("clickAt clicks viewport coordinates", at["tag"] == "button" and at["label"] == "Start task")

        shadow_box = page.evaluate("""() => {
          const r = document.getElementById('shadow-host').shadowRoot.getElementById('shadow-button').getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }""")
        result("clickAt", {"x": int(shadow_box["x"] + shadow_box["w"] / 2), "y": int(shadow_box["y"] + shadow_box["h"] / 2)})
        check("clickAt pierces shadow DOM", page.evaluate("document.getElementById('shadow-host').dataset.hit") == "yes")

        frame_box = page.evaluate("""() => {
          const f = document.getElementById('frame');
          const r = f.contentDocument.getElementById('frame-button').getBoundingClientRect();
          const fr = f.getBoundingClientRect();
          return { x: fr.x + r.x, y: fr.y + r.y, w: r.width, h: r.height };
        }""")
        framed = result("clickAt", {"x": int(frame_box["x"] + frame_box["w"] / 2), "y": int(frame_box["y"] + frame_box["h"] / 2)})
        check("clickAt pierces same-origin iframes", framed["label"] == "Frame button")

        read = result("read", {"maxChars": 12000})
        check("read includes shadow DOM text", "Shadow label" in read["markdown"])
        check("read includes iframe text", "Frame label" in read["markdown"])

        found = result("query", {"text": "Continue"})
        check("query finds the new control", found["count"] >= 1 and found["items"][0]["label"] == "Continue")

        result("clickText", {"text": "Remove", "nth": 1})
        check("clickText honors nth", page.evaluate("document.body.dataset.remove") == "1")

        filled = result("fill", {
            "fields": [
                {"label": "Email", "value": "ada@example.com"},
                {"label": "Message", "value": "Hello"},
                {"label": "Color", "value": "green"},
                {"label": "Shadow label", "value": "shadow value"},
                {"label": "Frame label", "value": "frame value"},
            ],
        })
        check("fill reports every field", len(filled["results"]) == 5 and all(r["ok"] for r in filled["results"]),
              str(filled))
        check("fill fills the normal input", page.input_value("#email") == "ada@example.com")
        check("fill fills the textarea", page.input_value("#message") == "Hello")
        check("fill selects an option", page.input_value("#color") == "green")
        check("fill fills a shadow input", page.evaluate(
            "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-field').value"
        ) == "shadow value")
        check("fill fills an iframe input", page.evaluate(
            "document.getElementById('frame').contentDocument.getElementById('frame-field').value"
        ) == "frame value")

        email = result("query", {"selector": "#email"})
        result("press", {"key": "Enter", "ref": email["items"][0]["ref"]})
        page.wait_for_timeout(100)
        check("press can submit a form", page.inner_text("#submitted") == "yes")

        waited = result("waitFor", {"text": "Loaded content", "timeoutMs": 4000})
        check("waitFor waits for late text", waited["state"] == "present")

        shadow_click = result("clickText", {"text": "Shadow action"})
        check("clickText reaches shadow DOM", shadow_click["label"] == "Shadow action")

        missing = call("clickText", {"text": "This label does not exist"})
        check("missing label returns an error", not missing.get("ok") and "No visible" in missing.get("error", ""))

        browser.close()
    server.shutdown()

    if failures:
        print(f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("\nALL BRIDGE CHECKS PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
