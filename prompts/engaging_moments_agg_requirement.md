# Top Engaging Moments Aggregation

## Task
From the candidate moments across video parts, select and rank the top {max_clips} most engaging, shareable clips.

## Ranking Criteria
**Primary**
- Engagement level (`high` > `medium` > `low`)
- Standalone viability and content completeness
- Memorability / shareability

**Secondary**
- Fit to the runtime Clip Length Preference
- Emotional impact or information density
- Diversity: avoid near-duplicate topics or the same beat repeated

**Type nuance** (use dominant content type lightly)
- entertainment → complete jokes/reactions; knowledge → insights that stand alone
- speech → peaks/quotes; opinion → strong takes/debates
- experience → emotional stories; business → actionable advice; content_review → unique takes

## User Focus
If a **User Focus** section is present:
- Rank matching moments above generic highlights
- Prefer fewer strong matches over filling {max_clips} with unrelated clips
- Keep `why_engaging` honest about intent fit

## Requirements
- Select up to {max_clips} (fewer is OK if not enough quality)
- Rank 1…N by engagement potential
- Do not invent new times — preserve source timing and `video_part`
- Maintain original titles unless clearly broken; no emoji evaluation bias
- Prefer diverse, non-redundant selections

## Output Format
Return ONLY valid JSON (no markdown fences, no extra text):

```json
{
  "top_engaging_moments": [
    {
      "rank": 1,
      "title": "...",
      "timing": {
        "video_part": "part02",
        "start_time": "00:15:30",
        "end_time": "00:17:15",
        "duration": 105
      },
      "summary": "...",
      "engagement_details": {
        "engagement_level": "high"
      },
      "why_engaging": "...",
      "tags": ["interactive", "humorous"]
    }
  ],
  "total_moments": 1,
  "analysis_timestamp": "2024-01-01T12:00:00Z",
  "aggregation_criteria": "engagement, standalone quality, duration fit, diversity",
  "analysis_summary": {
    "highest_engagement_themes": ["interactive", "humorous"],
    "total_engaging_content_time": "1 minute 45 seconds",
    "recommendation": "..."
  },
  "honorable_mentions": [
    {
      "title": "...",
      "timing": {
        "video_part": "part01",
        "start_time": "00:05:20",
        "end_time": "00:06:30",
        "duration": 70
      },
      "why_engaging": "..."
    }
  ]
}
```

### Field notes
- `timing`: `video_part`, `start_time`, `end_time`, `duration` (seconds); times as `HH:MM:SS` or `MM:SS` (convert from SRT if needed)
- Optional `honorable_mentions`: 2–3 near-misses without `rank`
- Preserve source content; do not hallucinate new clips
