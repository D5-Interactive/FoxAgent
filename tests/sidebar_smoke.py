#!/usr/bin/env python3
import functools
import http.server
import json
import os
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def state():
    return {
        "type": "state",
        "settings": {
            "provider": "lmstudio",
            "providers": {"lmstudio": {"model": "", "hasKey": False, "keyMask": "", "baseUrl": "http://localhost:1234/v1"}},
            "providerKeys": {"lmstudio": {"label": "LM Studio", "baseUrl": "http://localhost:1234/v1", "hint": "", "cloud": False, "kind": "", "keyUrl": ""}},
            "approval": {"read": "auto", "act": "confirm", "write": "confirm"},
            "trustedSites": [],
            "siteAllowlist": [],
            "packs": ["canvas"],
            "autoUpdate": False,
            "dryRun": False,
            "temperature": 0.2,
            "maxSteps": 32,
            "maxOutputTokens": 8192,
            "contextChars": 96000,
            "maxPageChars": 12000,
            "toolMode": "auto",
            "vision": "auto",
        },
        "tab": {"id": 2, "title": "Slides", "url": "https://docs.google.com/presentation/d/1", "active": True},
        "tabId": 2,
        "transcript": [],
        "notes": [],
        "busy": False,
        "pending": [],
        "sessions": [
            {"tabId": 1, "title": "Canvas", "url": "https://canvas.instructure.com/", "busy": True, "approvals": 0, "messages": 4, "lastAt": 2},
            {"tabId": 2, "title": "Slides", "url": "https://docs.google.com/presentation/d/1", "busy": False, "approvals": 0, "messages": 2, "lastAt": 1},
        ],
        "packs": [{"id": "canvas", "name": "Canvas LMS", "version": "1.1.0", "description": "Canvas pack", "hosts": ["*.instructure.com"], "icon": "/icons/fox-96.png", "enabled": True, "active": False}],
        "update": None,
        "log": [],
        "models": [],
        "modelsByProvider": {},
        "selectedModel": "",
        "provider": "lmstudio",
        "recipes": [{"id": "page.markdown", "tag": "Page", "title": "Extract this page", "hint": "Markdown"}],
    }


def main():
    server = serve()
    port = server.server_address[1]
    failures = []
    errors = []

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
        page = browser.new_page(viewport={"width": 420, "height": 900})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.add_init_script(
            """window.browser = {
              runtime: { connect: () => ({
                postMessage() {},
                onDisconnect: { addListener() {} },
                onMessage: { addListener(fn) { window.__deliver = fn; } }
              }) },
              windows: { getCurrent: async () => ({ id: 1 }) },
              tabs: { query: async () => [{ id: 2, active: true, title: "Slides", url: "https://docs.google.com/presentation/d/1" }] },
              storage: { local: { get: async () => ({}), set: async () => {} } }
            };"""
        )
        page.goto(f"http://127.0.0.1:{port}/src/sidebar/sidebar.html")
        page.wait_for_timeout(400)
        page.evaluate("(value) => window.__deliver(value)", state())
        page.wait_for_timeout(300)

        check("six panels are present", page.locator(".tab").count() == 6)
        page.click('[data-panel="chats"]')
        check("chats lists every tab", page.locator(".chat-row").count() == 2)
        check("current chat is marked", "current" in page.inner_text("#chatList"))
        page.click(".chat-row:nth-child(1) .btn:not(.danger)")
        check("open switches to chat", page.is_visible("#panel-chat"))
        page.click('[data-panel="tasks"]')
        tasks = page.inner_text("#recipeGroups")
        check("tasks are per tab", "Canvas" not in tasks and "Extract this page" in tasks)
        page.click('[data-panel="packs"]')
        check("pack is not marked active on slides", "this tab" not in page.inner_text("#packList"))
        check("no console errors", not errors, json.dumps(errors))
        browser.close()
    server.shutdown()

    if failures:
        print(f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("\nALL SIDEBAR CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
