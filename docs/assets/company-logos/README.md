# Company Logo SVGs — Reference

These are SVG logo references for use in the AI Pulse dashboard leaderboard.
All use `viewBox="0 0 24 24"` and `fill="currentColor"` for easy recolouring.

## Available 
- `anthropic.svg` — Anthropic "A" mark
- `openai.svg` — OpenAI spiral
- `google.svg` — Google "G"
- `meta.svg` — Meta infinity loop
- `mistral.svg` — Mistral pixel grid
- `deepseek.svg` — DeepSeek whale
- `xai.svg` — xAI mark
- `moonshot.svg` — Moonshot AI crescent

## Still needed
- Alibaba / Qwen
- Amazon 
- Cohere 
- AI21 — 


## Usage in dashboard

The `CompanyLogo` component in `dashboard.html` currently renders coloured circle
placeholders. To swap in real logos, replace the placeholder circle+text with the
SVG path data from these files. The component already accepts a `company` prop and
renders at 14x14px.
