You are classifying a piece of text into exactly one of the provided categories.

Categories: {{categories}}

Additional context (may be empty): {{context}}

Text to classify:
{{text}}

Pick the single best-fitting category from the list above. If nothing fits well, still pick the closest match and reflect low confidence.

Return ONLY a JSON object with exactly these three fields:
- "category": one of the category strings, verbatim
- "confidence": a number between 0.0 and 1.0 reflecting how sure you are
- "rationale": one sentence explaining the choice

No prose before or after. No markdown fences.
