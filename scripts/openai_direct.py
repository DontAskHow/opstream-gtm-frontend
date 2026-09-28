"""OpenAI chat completions for the refresh job, using OPENAI_API_KEY."""
import json
import urllib.error
import urllib.request

# Reasoning models spend max_completion_tokens on hidden reasoning first. With a
# small budget a long answer comes back empty with finish_reason "length".
JSON_BUDGET = 6000
JSON_RETRY_BUDGET = 16000


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
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError("OpenAI HTTP %s: %s" % (e.code, detail)) from None


def complete_json(call, payload, log):
    """One JSON object from the model, or ValueError with the reason.

    Starts with a budget large enough for reasoning plus the answer and low
    reasoning effort. An empty reply cut off by length is retried once with a
    larger budget. The reason for an empty reply is logged, never the prompt.
    """
    attempt = dict(payload)
    attempt["max_completion_tokens"] = max(int(payload.get("max_completion_tokens") or 0), JSON_BUDGET)
    attempt.setdefault("reasoning_effort", "low")
    for budget in (attempt["max_completion_tokens"], JSON_RETRY_BUDGET):
        attempt["max_completion_tokens"] = budget
        try:
            resp = call(attempt)
        except RuntimeError as e:
            if "reasoning_effort" not in str(e) or "reasoning_effort" not in attempt:
                raise
            log("model rejected reasoning_effort; retrying without it")
            attempt.pop("reasoning_effort")
            resp = call(attempt)
        choice = (resp.get("choices") or [{}])[0]
        content = str((choice.get("message") or {}).get("content") or "").strip()
        finish = choice.get("finish_reason")
        if content:
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else ""
                content = content.rsplit("```", 1)[0]
            return json.loads(content)
        details = ((resp.get("usage") or {}).get("completion_tokens_details") or {})
        log("model %s returned no text: finish_reason %s, %s reasoning tokens of a %d budget" % (
            resp.get("model") or attempt.get("model"), finish, details.get("reasoning_tokens"), budget))
        if finish != "length":
            break
    raise ValueError("the model returned no text")
