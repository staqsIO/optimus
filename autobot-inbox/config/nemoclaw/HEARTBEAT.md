# Heartbeat Checklist (runs every 30 minutes)

1. Check pipeline health: `curl -s -H "Authorization: Bearer $OPTIMUS_TOKEN" $OPTIMUS_API/api/pipeline/health`
   - Flag any items stuck > 2 hours
   - Note queue depths

2. Check pending drafts: `curl -s -H "Authorization: Bearer $OPTIMUS_TOKEN" $OPTIMUS_API/api/drafts`
   - Auto-approve clear-cut noise/FYI drafts
   - Flag anything involving commitments, money, or external parties

3. Check pending intents: `curl -s -H "Authorization: Bearer $OPTIMUS_TOKEN" $OPTIMUS_API/api/intents`
   - Approve routine operational intents
   - Flag unusual or high-risk intents

4. Log summary to daily memory
