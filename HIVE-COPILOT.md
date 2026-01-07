# Hive Copilot

**AI-Powered Assistant for Zendesk Support Agents**

## Overview

Hive Copilot is an intelligent sidebar application for Zendesk Support that helps agents respond to merchant inquiries faster and more accurately. It automatically analyzes incoming tickets, searches internal documentation (Notion), and generates contextual suggested responses using AI.

## What It Does

When a support agent opens a ticket in Zendesk, Hive Copilot:

1. **Analyzes the Ticket** - Reads the subject, comments, requester info, and conversation history
2. **Searches Knowledge Base** - Automatically queries Notion for relevant SOPs and documentation based on extracted keywords
3. **Learns Agent Style** - Fetches active Zendesk macros to understand the team's communication style and tone
4. **Generates AI Response** - Uses OpenAI (GPT-4o-mini) to produce:
   - A **Summary** of the entire conversation
   - **Next Steps** - Recommended actions based on procedures
   - **Suggested Response** - A draft reply in the correct language and style
5. **Enables Follow-up Chat** - Agents can ask clarifying questions or request revisions
6. **One-Click Insert** - Suggested responses can be inserted directly into the Zendesk reply box

## Key Features

### Intelligent Search Term Extraction
The system extracts meaningful keywords from tickets, prioritizing domain-specific terms (shipping, label, tracking, carrier, etc.) and using bigrams for multi-word phrases to find the most relevant documentation.

### Multilingual Support
Hive Copilot detects the customer's language and responds in the same language automatically.

### Style Matching
By analyzing Zendesk macros, the AI learns how the support team writes and matches that tone in suggested responses.

### Performance Optimizations
- In-memory caching for Notion pages (5-minute TTL)
- Rate limiting to prevent API abuse
- Macro caching to avoid redundant API calls
- Only fetches content from top 2 most relevant pages

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Zendesk Support                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Ticket Sidebar                     │   │
│  │  ┌───────────────────────────────────────────────┐  │   │
│  │  │            Hive Copilot Widget                │  │   │
│  │  │                                               │  │   │
│  │  │  • Summary                                    │  │   │
│  │  │  • Next Steps                                 │  │   │
│  │  │  • Suggested Response [Insert]                │  │   │
│  │  │  • Sources (expandable)                       │  │   │
│  │  │  • Follow-up Chat                             │  │   │
│  │  │                                               │  │   │
│  │  └───────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│               Vercel Serverless Functions                   │
│                                                             │
│  POST /api/copilot     POST /api/chat                       │
│       │                     │                               │
│       └─────────┬───────────┘                               │
│                 │                                           │
│     ┌───────────┴───────────┐                               │
│     ▼                       ▼                               │
│  Notion API            OpenAI API                           │
│  (Knowledge Base)      (GPT-4o-mini)                        │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Zendesk App | ZAF SDK 2.0 | Sidebar widget UI |
| API | Vercel Serverless | Request handling |
| Knowledge Base | Notion API | SOP/documentation storage |
| AI Engine | OpenAI GPT-4o-mini | Response generation |

## Project Structure

```
hive-copilot/
├── api/
│   ├── copilot.js          # Main analysis endpoint
│   ├── chat.js             # Follow-up conversation endpoint
│   └── lib/
│       ├── notion.js       # Notion search & content extraction
│       ├── openai.js       # AI response generation
│       └── rateLimit.js    # Request rate limiting
│
├── zendesk-app/
│   ├── manifest.json       # Zendesk app configuration
│   ├── translations/
│   │   └── en.json         # English translations
│   └── assets/
│       ├── index.html      # App UI structure
│       ├── main.js         # Frontend logic
│       ├── style.css       # Styling (Hive brand)
│       ├── logo.png        # 512x512 admin icon
│       └── logo-small.png  # 128x128 sidebar icon
│
└── HIVE-COPILOT.md         # This documentation
```

## How It Was Created

### The Problem

Hive's support team handles a high volume of merchant inquiries about shipping, labels, tracking, and fulfillment. Agents were spending significant time:
- Searching through Notion documentation for SOPs
- Crafting responses from scratch for common issues
- Maintaining consistency in tone and format across the team

### The Solution

Hive Copilot was built to automate these repetitive tasks by:

1. **Connecting Notion as a Knowledge Source** - The team already maintained SOPs and documentation in Notion. The copilot searches this automatically when tickets arrive.

2. **Learning from Existing Macros** - Rather than training a custom model, the system uses existing Zendesk macros as style examples, ensuring responses match the established team voice.

3. **Leveraging Modern AI** - OpenAI's GPT-4o-mini provides fast, cost-effective response generation that understands context and can adapt to different languages.

### Development Timeline

The project was developed with a focus on rapid deployment:

1. **API Development** - Vercel serverless functions were chosen for zero-config deployment and automatic scaling
2. **Notion Integration** - Built a smart search system with relevance scoring and caching
3. **OpenAI Integration** - Designed prompts that structure output consistently (Summary, Next Steps, Suggested Response)
4. **Zendesk App** - Created a ZAF 2.0 sidebar app with clean UI following Hive's brand colors
5. **Follow-up Chat** - Added conversational capability so agents can refine suggestions

### Technical Decisions

- **GPT-4o-mini over GPT-4** - Chosen for speed and cost-effectiveness; sufficient for support responses
- **Vercel over AWS** - Simpler deployment, automatic HTTPS, seamless GitHub integration
- **In-memory caching** - Good enough for serverless cold starts; Redis considered for production scale
- **ZAF 2.0** - Latest Zendesk framework with modern JavaScript support

## Deployment

### API (Vercel)
```bash
npx vercel --prod
```

### Zendesk App
```bash
cd hive-copilot
zip -r hive-copilot-zendesk-app.zip zendesk-app -x "*.DS_Store"
# Upload via Zendesk Admin Center
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API authentication |
| `NOTION_API_TOKEN` | Notion integration token |
| `NOTION_ROOT_PAGE_ID` | (Optional) Scope searches to specific page tree |

## Future Considerations

- **Redis caching** - For better performance at scale
- **Ticket tagging** - Automatically suggest or apply tags based on analysis
- **Metrics dashboard** - Track usage, response quality, time saved
- **Custom training** - Fine-tune on historical resolved tickets
- **More knowledge sources** - Integrate additional documentation platforms

---

**Production URL:** https://hive-copilot.vercel.app

**Version:** 1.0.1

**Author:** Hive Technologies
