"""OpenAI chat completion using OPENAI_API_KEY. No vault CLI."""
import json
import urllib.request


def chat_completion(payload, api_key):
    body = dict(payload)
    model = str(body.get("model") or "")
    # Tool calls use gpt-6-sol with reasoning_effort none. Background jobs use luna.
    if "sol" in model and "reasoning_effort" not in body:
        body["reasoning_effort"] = "none"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))
