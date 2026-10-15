# Guava Typescript SDK
[![NPM Version](https://img.shields.io/npm/v/%40guava-ai%2Fguava-sdk)](https://www.npmjs.com/package/@guava-ai/guava-sdk)

This library allows you to build Guava voice agents using TypeScript or Javascript. Currently only NodeJS is officially supported as a runtime for the main SDK. The WebRTC portion of the SDK can be used from the browser.

## Documentation

Full documentation for the TypeScript SDK can be found at [https://goguava.ai/docs/](https://goguava.ai/docs/). SDK examples can be found under [./examples/](https://github.com/goguava-ai/typescript-sdk/tree/main/examples).

## Authentication

Log in using the [Guava CLI](https://goguava.ai/docs/quickstart):

```shell
guava login
```

Alternatively, provide an API key through an environment variable.

```shell
$ export GUAVA_API_KEY="..." # Your API key for authentication.
$ export GUAVA_AGENT_NUMBER="..." # A phone number for your agent to use.
```

## Try an Example

Run an outbound phone call example using `npx`. Replace the phone number with your own and your agent will call you.

```bash
$ npx @guava-ai/guava-sdk@latest scheduling-outbound phone +15556667777 # Your agent will call this number.
```

## Installation

Install the SDK using your preferred package manager.

```bash
$ npm install @guava-ai/guava-sdk
$ yarn add @guava-ai/guava-sdk
$ pnpm add @guava-ai/guava-sdk
```

The SDK can be used with Javascript, but TypeScript is highly recommended.

## Using WebRTC from the Browser

To call your agent from the browser with a bundler, install the SDK as above and import from `@guava-ai/guava-sdk/webrtc`.

```typescript
import * as Guava from "@guava-ai/guava-sdk/webrtc";

const call = new Guava.Call({ webrtcCode: "..." });
await call.start();
```

You can also load a prebuilt bundle from a CDN.

```html
<script
  src="https://cdn.jsdelivr.net/npm/@guava-ai/guava-sdk@0.40.0/dist/guava-webrtc.min.js"
  integrity="sha384-uQk/PbfYN8B4stNmOZcjiXXLwfH7WgfV/qS0oDayomXmtC2a6+5idq9kErN96aP5"
  crossorigin="anonymous"
></script>
<script>
  const call = new Guava.Call({ webrtcCode: "..." });
  call.start();
</script>
```

Or as an ES module:

```html
<script type="importmap">
  {
    "integrity": {
      "https://cdn.jsdelivr.net/npm/@guava-ai/guava-sdk@0.40.0/dist/guava-webrtc.esm.min.js": "sha384-Kj5mMp2CvcMvf0d6MiAbFsD6/27EnYexIRXV25A5aWO7cKQw5BVxc+3c6h5WyXkF"
    }
  }
</script>
<script type="module">
  import * as Guava from "https://cdn.jsdelivr.net/npm/@guava-ai/guava-sdk@0.40.0/dist/guava-webrtc.esm.min.js";
  const call = new Guava.Call({ webrtcCode: "..." });
  await call.start();
</script>
```

See the [WebRTC calling guide](https://docs.goguava.ai/guides/webrtc-calls) for more details on how to create WebRTC agents with Guava.