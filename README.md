# Guava Typescript SDK
[![NPM Version](https://img.shields.io/npm/v/%40guava-ai%2Fguava-sdk)](https://www.npmjs.com/package/@guava-ai/guava-sdk)

This library allows you to build Guava voice agents using TypeScript or Javascript. Currently only NodeJS is officially supported as a runtime.

## Documentation

Full documentation for the TypeScript SDK can be found at [https://docs.goguava.ai/typescript-sdk/](https://docs.goguava.ai/typescript-sdk/)

## Try an Example

Export two environment variables. You should have received these in your beta invite email.
```bash
$ export GUAVA_API_KEY="..." # Your API key for authentication.
$ export GUAVA_AGENT_NUMBER="..." # A phone number for your agent to use.
```

Run an outbound phone call example using `npx`. Replace the phone number with your own and your agent will call you.
```bash
$ npx @guava-ai/guava-sdk@latest scheduling-outbound +15556667777 # Your agent will call this number.
```

## Installation

Install the SDK using your preferred package manager.

```bash
$ npm install @guava-ai/guava-sdk
$ yarn add @guava-ai/guava-sdk
$ pnpm add @guava-ai/guava-sdk
```

The SDK can be used with Javascript, but TypeScript is highly recommended.

## Basic Usage

The Guava SDK is primarily used by subclassing `guava.CallController`. `CallController` subclasses implement callbacks that steer the call in real-time.

You can make outbound calls using a `CallController` instance.

```typescript
import * as guava from "@guava-ai/guava-sdk";

// Make an outbound call with a call controller.
new guava.Client().createOutbound(
    agentNumber, toNumber,
    new MyCallController(),
);
```

You can also accept inbound calls using Guava. You don't need to setup a server — inbound calls can be received on your dev machine, including behind NATs and most firewalls.
Instead of passing a controller, you will pass a factory function that constructs a controller upon receipt of a call.

```typescript
// Attach a listener to the phone number.
// Spawn new call controllers as calls come in.
new guava.Client().listenInbound(
    { agent_number: agentNumber },
    () => new MyCallController(),
);
```