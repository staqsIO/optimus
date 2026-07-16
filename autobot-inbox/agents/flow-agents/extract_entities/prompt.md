Extract structured entities from the following text.

Entity types to extract: {{entityTypes}}

Additional context (may be empty): {{context}}

Text:
{{text}}

For each entity you find, produce an object with:
- "type": one of the requested entity type strings, verbatim
- "value": the extracted value as a string (normalize dates to ISO format YYYY-MM-DD when possible, amounts to plain numbers with currency as a separate field if present, URLs fully qualified)
- "snippet": a short quote (<= 80 chars) from the source text showing where the entity appeared

Include every occurrence. If an entity appears multiple times, include it multiple times with different snippets. If a requested type is not found, do not include it in the output — just return fewer items.

Return ONLY a JSON object with exactly one field:
- "entities": an array of the objects described above (may be empty)

No prose before or after. No markdown fences.
