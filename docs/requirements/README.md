# Requirements

25 Nov 2026. What openmorals must do, how each requirement is judged met, and where each one stands. These pages sit above the detailed tables in [product/requirements.md](../product/requirements.md), which give every check its own id and test.

| Page | What it holds |
|---|---|
| [requirements.md](requirements.md) | Product requirements by area, each with the condition that makes it met and its status |
| [coverage.md](coverage.md) | The features by layer with the evidence behind each, and which hosts and model APIs openmorals reaches today |
| [next.md](next.md) | Requirements for the next pieces of work: the memory-file guard, a first run on a live agent, and token control |

## Status words

- **Built (version)**: in that release, with the case table or test the [CHANGELOG](../../CHANGELOG.md) names. "Not run live" is added where no live agent has been run, which today is every host.
- **In progress**: written in an open pull request, not yet released.
- **Planned**: not built. Planned items may change or be dropped.
- **Rejected**: will not be built, with the reason.

A status is only as good as its check. These pages were checked against the code and the CHANGELOG on 25 Nov 2026 (release 0.35.0). Figures such as catch rates come from the project's own case tables, which the same project wrote, unless a page says otherwise.
