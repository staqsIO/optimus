# Getting Started — Spec Collaboration Guide

> **Full project onboarding:** See [`ONBOARDING.md`](../ONBOARDING.md) at the repo root for the complete onboarding guide covering all contributors, dev setup, and architecture orientation. This file covers the **spec collaboration workflow only**.

Welcome to the repo. This replaces our iMessage doc exchanges with something version-controlled and agent-friendly. Everything we've done so far is already here.

---

## 1. One-Time Setup (15 minutes)

### Install Git

If you don't have Git installed:

```bash
# macOS (this will prompt you to install Xcode Command Line Tools if needed)
git --version

# If it says "not found", run:
xcode-select --install
```

### Install GitHub CLI

This makes GitHub operations much easier than the website:

```bash
# macOS with Homebrew
brew install gh

# If you don't have Homebrew:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install gh
```

### Authenticate with GitHub

```bash
gh auth login
```

Choose:
- GitHub.com
- HTTPS
- Login with a web browser
- Follow the prompts

### Clone the Repo

```bash
# This downloads the repo to your computer
cd ~/Documents  # or wherever you keep projects
gh repo clone staqsIO/autobot-spec
cd autobot-spec
```

You now have the full repo locally. You can open it in VS Code, Cursor, or any text editor.

---

## 2. Understanding the Repo

```
autobot-spec/
├── SPEC.md              ← THE canonical spec. Current state of the architecture.
├── CHANGELOG.md         ← What changed in each version
├── CLAUDE.md            ← Instructions for AI agents working in this repo
├── README.md            ← Overview and workflow
├── conversation/        ← Our full thread (001-007), preserved chronologically
├── decisions/           ← Architecture Decision Records (why we chose X over Y)
├── open-questions/      ← Things we haven't resolved yet
└── reviews/             ← Agent review outputs
```

**The most important file is `SPEC.md`.** That's the document we're evolving. Everything else supports it.

---

## 3. The Workflow (How We Iterate)

### Reading (no Git knowledge needed)

You can always read everything on GitHub at:
**https://github.com/staqsIO/autobot-spec**

Click any `.md` file and GitHub renders it nicely.

### Proposing Changes (the main workflow)

When you want to propose changes to the spec:

```bash
# 1. Make sure you have the latest version
cd ~/Documents/autobot-spec   # or wherever you cloned it
git pull

# 2. Create a branch for your proposal
git checkout -b dustin/your-topic-name
# Examples:
#   git checkout -b dustin/refine-three-laws
#   git checkout -b dustin/openclaw-threat-model
#   git checkout -b dustin/distribution-mechanism

# 3. Edit files
# Open SPEC.md (or any file) in your editor and make changes.
# You can also add new files to conversation/, reviews/, etc.

# 4. Save your changes to Git
git add -A
git commit -m "A short description of what you changed"

# 5. Push your branch to GitHub
git push -u origin dustin/your-topic-name

# 6. Create a Pull Request
gh pr create --title "Short title of your proposal" --body "Explain your reasoning here"
```

That's it. I'll see the PR, review it (possibly run it through my agents), and we'll discuss in the PR comments.

### Quick Reference Card

| What you want to do | Command |
|---------------------|---------|
| Get latest changes | `git pull` |
| See what you've changed | `git status` |
| See the actual changes | `git diff` |
| Start a new proposal | `git checkout -b dustin/topic-name` |
| Save your work | `git add -A && git commit -m "description"` |
| Push to GitHub | `git push -u origin dustin/topic-name` |
| Create a PR | `gh pr create` |
| Go back to main branch | `git checkout main` |
| Discard all local changes | `git checkout .` |

### If Something Goes Wrong

```bash
# "I messed up and want to start over"
git checkout main
git pull
# Then create a fresh branch

# "I got a merge conflict"
# Don't panic. Ask me or run:
git merge --abort
# Then we'll figure it out together

# "I committed to main by accident"
# It's fine — there's no branch protection. Just tell me and we'll fix it.
```

---

## 4. Using Your Agents

The whole point of this repo is that we can each use our own agent setups to iterate. Here's how:

### If You Use Claude Code

```bash
cd ~/Documents/autobot-spec
claude
# Claude Code will read CLAUDE.md automatically and understand the repo
# Ask it to review the spec, propose changes, analyze open questions, etc.
```

### If You Use Cursor / Another AI IDE

Just open the repo folder. The CLAUDE.md file provides context for any AI assistant.

### Saving Agent Outputs

When your agents produce a review or analysis you want to keep:

1. Save it in `reviews/` with the format: `YYYY-MM-DD-agent-topic.md`
2. Example: `reviews/2026-02-27-claude-distribution-analysis.md`
3. Reference it in your PR description

---

## 5. Adding a New Conversation Entry

When you write a full response (like the docs we've been exchanging):

```bash
# Check what number is next
ls conversation/
# If the last one is 007, yours is 008

# Create your file
# conversation/008-dustin-response-to-pentland.md

# Write your response in that file, then:
git add conversation/008-dustin-response-to-pentland.md
git commit -m "Dustin's response to Pentland data governance framework"
git push
```

---

## 6. What's Already Here

All 7 of our conversation documents are imported:

| # | File | Author | Content |
|---|------|--------|---------|
| 001 | `001-dustin-agent-org-v0.1.md` | Dustin | Original agent org architecture |
| 002 | `002-eric-initial-response.md` | Eric | Initial skeptical response |
| 003 | `003-eric-revised-response.md` | Eric | Detailed revision with infrastructure |
| 004 | `004-dustin-autobot-spec.md` | Dustin | AutoBot autonomous spec |
| 005 | `005-eric-unified-v3.md` | Eric | Unified v3 with Pentland framework |
| 006 | `006-eric-previous-response.md` | Eric | Previous response |
| 007 | `007-dustin-v0.4-canonical.md` | Dustin | v0.4 canonical spec (current SPEC.md) |

Plus review outputs, the Pentland framework analysis, and the multi-agent audit justification.

---

## 7. Questions?

If anything is unclear, just ask. The repo is the collaboration surface — iMessage is still fine for quick questions and coordination. The goal is just to get the spec evolution out of iMessage attachments and into something that tracks history and lets us both use our agents against it.
