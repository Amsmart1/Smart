import asyncio
from playwright.async_api import async_playwright
import os

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1200, 'height': 2400})

        page.on("console", lambda msg: print(f"BROWSER CONSOLE: {msg.text}"))

        print("Navigating to verify_analytics.html...")
        await page.goto("http://localhost:8000/verify_analytics.html", wait_until="networkidle")

        # Check if renderAnalytics was called
        content = await page.content()
        # print("Page content length:", len(content))

        await asyncio.sleep(5) # Wait for async operations

        os.makedirs('verification/screenshots', exist_ok=True)
        await page.screenshot(path='verification/screenshots/analytics_overhaul_success.png', full_page=True)
        print("Screenshot saved.")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
