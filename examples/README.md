# Examples

- [example.test.ts](./example.test.ts) - Agent testing example demonstrating `agent.test()`, `agent.testRoleplay()`, `agent.patch()`, and `session.evaluate()` for unit testing handlers, scripted conversation flows, LLM-driven roleplay, and natural-language pass/fail evaluation.
- [help-desk.ts](./help-desk.ts) - An inbound call agent for a furniture retailer that uses `DocumentQA` for RAG-based question answering and `IntentRecognizer` to classify caller intent and route to the appropriate department.
- [polling-campaign.ts](./polling-campaign.ts) - Attaches a political polling agent to an existing Guava campaign via `attachCampaign()`, uses `reachPerson()` to confirm availability, then conducts a structured poll with text and multiple-choice fields.
- [property-insurance.ts](./property-insurance.ts) - A simple inbound call agent that uses `DocumentQA` and RAG to answer questions about a property insurance policy.
- [restaurant-waitlist.ts](./restaurant-waitlist.ts) - An inbound call agent that collects a caller's name, party size, and phone number to add them to a restaurant waitlist using a structured task checklist.
- [scheduling-outbound.ts](./scheduling-outbound.ts) - An outbound call agent for a dental office that calls patients to schedule appointments, using `reachPerson()` for human detection and `DatetimeFilter` for searchable calendar slot availability.
