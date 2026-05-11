#!/usr/bin/env python3
"""Halo — backend server. Issues ephemeral tokens for the Gemini Live API."""

import asyncio
import datetime
import os

from aiohttp import web
from google import genai
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.environ.get("PORT", 8000))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    print("⚠️  GEMINI_API_KEY not set — check your .env file.")
    client = genai.Client(http_options={"api_version": "v1alpha"})
else:
    client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": "v1alpha"})


@web.middleware
async def cors_middleware(request, handler):
    if request.method == "OPTIONS":
        return web.Response(headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


async def get_ephemeral_token(request):
    try:
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        token = client.auth_tokens.create(config={
            "uses": 1,
            "expire_time": (now + datetime.timedelta(minutes=30)).isoformat(),
            "new_session_expire_time": (now + datetime.timedelta(minutes=1)).isoformat(),
            "http_options": {"api_version": "v1alpha"},
        })
        return web.json_response({"token": token.name})
    except Exception as e:
        print(f"Token error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def main():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_post("/api/token", get_ephemeral_token)
    app.router.add_options("/api/token", lambda r: web.Response(status=204))

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    print(f"Halo server running on http://0.0.0.0:{PORT}")
    print("POST /api/token  →  issues ephemeral Gemini Live token")

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
