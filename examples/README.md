# Examples

- ./property-insurance.ts - A simple inbound phone call example demonstrating use of RAG and the `DocumentQA` class to answer property insurance policy questions from a knowledge base.
- ./help-desk.ts - An inbound phone call example for a furniture retailer that uses `DocumentQA` to answer caller questions and `IntentRecognizer` to classify requests and transfer callers to the appropriate department (sales, delivery/returns, account management, or general support).
- ./restaurant-waitlist.ts - An inbound phone call example where an agent collects a caller's name, party size, and phone number to add them to a restaurant waitlist, then confirms and ends the call.
- ./scheduling-outbound.ts - An outbound phone call example for a dental office that calls patients to schedule appointments, using `reachPerson` to confirm a live answer and `DatetimeFilter` to search available calendar slots.
