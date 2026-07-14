# Engaging Moments Analysis - Video Part

## Task
Analyze the provided transcript and identify engaging moments suitable for short clips.

**CRITICAL**: Only use the transcript provided. Every timestamp MUST appear in that transcript — never invent or use placeholders.

## Content Type
Pick one primary type, then apply the matching priorities below (plus the general criteria).

| Type | Prioritize |
|------|------------|
| **entertainment** | Complete jokes (setup → punchline → reaction), climaxes, chat/audience reactions |
| **knowledge** | Aha moments, actionable tips; include enough setup to stand alone |
| **speech** | Emotional peaks, memorable quotes, narrative climax; stand alone |
| **opinion** | Strong/surprising takes, debates; include the triggering question/context if present |
| **experience** | Personal stories with emotional depth and relatability |
| **business** | Expert insights and actionable advice that make sense alone |
| **content_review** | Unique opinions, bold takes, sharp comparisons |

## General Engagement Criteria
Prefer moments with: emotional impact, information value, interactivity, memorability, relatability.
Prefer segments that are complete (clear arc), well-paced, authentic, and unique.

## Do NOT Select
- Openings: greetings, logistics, "welcome back", schedule talk
- Ads, sponsorship reads, product plugs
- Pure filler, small talk, or topic transitions with no payoff
- Repeated restatements of the same point
- Incomplete thoughts cut mid-sentence or mid-argument

## Duration
- Follow the runtime **Clip Length Preference** section injected by OpenClip (hard min/max and ideal range)
- Prefer a natural arc that fits the range; do not pad weak context just to hit length
- If shorter than minimum, extend only when nearby context improves standalone quality
- If longer than maximum, split or trim to the strongest complete arc

## Time Boundaries (Critical)
- Copy timestamps **exactly** as shown in the transcript
- `00:01:55` = 1 min 55 sec — NOT `01:55:00` (1 hr 55 min)
- Do not use placeholders like `HH:MM:SS` or example times
- `start_time`: first core statement of the moment; skip prior filler
- `end_time`: last sentence that completes the moment; end at a natural pause/summary — never blindly use the transcript end
- Do not cut mid-sentence, mid-key-point, or mid-reasoning
- Moments must not overlap; if they do, keep the stronger one

## Standalone Quality
Each clip should be understandable without the rest of the video. Include brief setup (question, claim being answered) when it appears nearby in the transcript.

## User Focus
If a **User Focus** section is present in this prompt:
- Prefer moments that match that focus
- If none match well, return fewer moments (or an empty array) rather than forcing unrelated "generic highlights"
- In `why_engaging`, note whether/how the moment matches the user focus

## Titles, Tags, Levels
- Titles: compelling, no emojis; follow language-specific title guidelines
- Avoid sensitive, hateful, or offensive wording
- `engagement_level`: `"high"` | `"medium"` | `"low"`
- Tags from: `["co-hosting", "interactive", "humorous", "live-chemistry", "funny", "highlight", "reaction", "gaming", "chat-interaction", "insight", "inspiring", "controversial", "relatable", "valuable", "educational"]`
- `summary`: 1–2 sentences on what happens (not why it is engaging)
- `why_engaging`: why a viewer would care

## Analysis Steps
1. Read the full transcript
2. Classify content type
3. Select candidates using general + type criteria; apply exclusions
4. Verify timestamps exist; check duration and non-overlap
5. Write summary, title, tags, why_engaging
6. Quality over quantity — empty `engaging_moments` is better than weak forced picks

## Output Format
Return ONLY valid JSON (no markdown fences, no extra text):

```json
{
  "video_part": "part01",
  "detected_content_type": "entertainment",
  "engaging_moments": [
    {
      "title": "...",
      "start_time": "00:01:55",
      "end_time": "00:03:10",
      "duration_seconds": 75,
      "summary": "...",
      "engagement_details": {
        "engagement_level": "high"
      },
      "why_engaging": "...",
      "tags": ["interactive", "humorous"]
    }
  ],
  "total_moments": 1,
  "analysis_timestamp": "2024-01-01T12:00:00Z"
}
```

### Required fields
- Top-level: `video_part`, `detected_content_type`, `engaging_moments`, `total_moments`, `analysis_timestamp`
- Each moment: `title`, `start_time`, `end_time`, `duration_seconds`, `summary`, `engagement_details.engagement_level`, `why_engaging`, `tags`
- Times: `HH:MM:SS` or `MM:SS` (not SRT milliseconds)
- If none qualify: `"engaging_moments": []`, `"total_moments": 0`
