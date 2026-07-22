# Examples

- [agent-testing.test.ts](./agent-testing.test.ts) - Test suite for the help-desk agent demonstrating `agent.test()`, `agent.testRoleplay()`, `agent.patch()`, handler unit tests with `MockCall`, and LLM-evaluated assertions with `session.evaluate()`.
- [help-desk.ts](./help-desk.ts) - Inbound call agent for a furniture retailer that uses `DocumentQA` for RAG-backed question answering and `IntentRecognizer` to route callers to the correct department (sales, delivery, account management).
- [multiple-agents.ts](./multiple-agents.ts) - Demonstrates running two independent agents simultaneously on different connection types (phone and WebRTC) using a shared `Runner`.
- [polling-campaign.ts](./polling-campaign.ts) - Outbound campaign agent that conducts a non-partisan political opinion poll, uses `reachPerson` to confirm contact availability, and collects structured responses via a task checklist.
- [property-insurance.ts](./property-insurance.ts) - Inbound call agent for a property insurance company that uses `DocumentQA` to answer policy questions from a knowledge base.
- [restaurant-waitlist.ts](./restaurant-waitlist.ts) - Inbound call agent for a restaurant that collects caller name, party size, and phone number to add callers to a waitlist using a structured task.
- [scheduling-outbound.ts](./scheduling-outbound.ts) - Outbound call agent for a dental office that uses `reachPerson` to confirm contact availability, then schedules appointments using a searchable calendar-slot field backed by `DatetimeFilter`.
