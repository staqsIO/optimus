---
title: "Board Documentation"
description: "Documentation index for the human board overseeing AutoBot Inbox."
---

# AutoBot Inbox -- Board Documentation

This documentation is for the human board (Eric and Dustin) overseeing AutoBot Inbox, the first operational instance of the Optimus governed agent organization. These documents cover how to operate, monitor, and control the system. For architecture decisions and technical implementation details, refer to the engineering docs in the main repository.

## Documents

| Document | Description |
|----------|-------------|
| [Product Overview](./product-overview.md) | What AutoBot Inbox does, how it works, and the board's role |
| [Getting Started](./getting-started.md) | How to set up and run the system from scratch |
| [Dashboard Guide](./dashboard-guide.md) | Guide to the web dashboard -- pages, actions, and what to look for |
| [CLI Guide](./cli-guide.md) | Guide to the command-line interface for quick operations |
| [FAQ](./faq.md) | Frequently asked questions about cost, safety, data, and operations |
| [Changelog](./changelog.md) | Version history and what changed in each release |

## Quick Reference

| Task | Where |
|------|-------|
| Review and approve drafts | Dashboard > Drafts, or CLI `review` command |
| Check daily cost | Dashboard > Home (top strip) or CLI `stats` command |
| Emergency stop | Dashboard > System > Halt, or CLI `halt` command |
| View today's briefing | Dashboard > Home, or CLI `briefing` command |
| Check L0 exit progress | Dashboard > Metrics, or CLI `stats` command |

## Current Status

- **Phase**: 1 (single inbox, single operator)
- **Autonomy Level**: L0 (all drafts require board approval)
- **Budget Ceiling**: $20/day
- **Spec Version**: autobot-spec v0.7.0
