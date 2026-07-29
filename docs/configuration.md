# Provider and model configuration

ArchCode uses one server-wide `~/.archcode/config.json`: `provider` contains named Provider entries, each with `npm`, display-only `name`, JSON `options`, and `models`; `profiles` contains exactly `principal`, `deep`, and `fast`, each selecting a `providerId:modelId` plus optional `variant` and call `options`. The removed per-Agent `agents` section is rejected. The Provider ID is the runtime namespace and is not derived from `name`.

When the file is missing, use the one-time Setup URL printed by the server
instead of creating it manually. Setup can also enable the optional instance
password. Its Argon2id hash is stored under internal `auth.passwordHash`, but
that field is deliberately absent from Config API snapshots and edits. Set,
change, or remove the password only through **Settings → Security**.

## Minimal example

The browser Setup is the recommended first-run path. For advanced or automated
provisioning, this example connects one OpenAI-compatible endpoint and assigns
the same model to all three required Profiles:

```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local model",
      "options": {
        "baseURL": "http://localhost:8090/v1",
        "apiKey": "replace-me"
      },
      "models": {
        "your-model-id": {
          "name": "Your model",
          "limit": {
            "context": 128000,
            "output": 16384
          },
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          }
        }
      }
    }
  },
  "profiles": {
    "principal": { "model": "local:your-model-id" },
    "deep": { "model": "local:your-model-id" },
    "fast": { "model": "local:your-model-id" }
  }
}
```

Provider IDs and model IDs combine as `provider:modelId`, such as
`local:your-model-id`. A versioned starting file is also available at
[`config.example.json`](../config.example.json).

## Supported packages

The catalog contains exactly these official AI SDK language Provider packages:

- `@ai-sdk/alibaba`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/anthropic`, `@ai-sdk/azure`
- `@ai-sdk/baseten`, `@ai-sdk/cerebras`, `@ai-sdk/cohere`, `@ai-sdk/deepinfra`, `@ai-sdk/deepseek`, `@ai-sdk/fireworks`
- `@ai-sdk/gateway`, `@ai-sdk/google`, `@ai-sdk/google-vertex`, `@ai-sdk/groq`, `@ai-sdk/huggingface`
- `@ai-sdk/mistral`, `@ai-sdk/moonshotai`, `@ai-sdk/openai`, `@ai-sdk/perplexity`, `@ai-sdk/togetherai`, `@ai-sdk/vercel`, `@ai-sdk/xai`

`@ai-sdk/openai-compatible` is for any Chat Completions-compatible custom or local endpoint. Its `baseURL` is required. `@ai-sdk/open-responses` is for a Responses-compatible endpoint. Its `url` is required. Both use the Provider ID, not `name`, as their runtime namespace.

`options` holds the selected factory's JSON options. Examples include `apiKey`, `baseURL`, `headers`, cloud project/region fields, and provider-specific settings. Settings redacts adapter-declared secrets, including API keys and custom header/query values. Never put credentials in model, variant, or Agent `providerOptions`; those are call options and reject secret-bearing keys.

## Profiles and execution bindings

- Root Lead defaults to `principal`, including ordinary Sessions, Todo Discussions, Automations, and Goal continuations.
- Analyst requires `deep`; Explore and Librarian require `fast`; Build accepts `deep` or `fast` selected by Lead at delegation time.
- A Profile changes model resources only. Agent identity controls tools and delegation; Skills control workflow guidance.
- Profile-default call options merge as `model.options → variants[profile.variant] → profiles[profile].options`. `providerOptions` is shallow-replaced like any other top-level key.
- If a Profile still names a removed variant, Settings marks that Profile for attention but allows the document to save. Runtime omits the missing variant and uses the model default plus Profile options until the reference is repaired. An empty Profile variant is normalized to Default; an unknown Profile model remains a validation error.
- A root Lead Session override is a complete alternative selection. It resolves the chosen model and variant without inheriting `principal` options; clearing it returns to `principal`.

Saving in **Settings → Models / Profiles** validates the complete document, prepares the new Provider registry, writes atomically, then publishes Models and Profile defaults immediately. It returns the disk revision, the published model-runtime revision, and any restart-required sections: `mcp`, `memory`, or `integrations.github`.

Editing `~/.archcode/config.json` outside Settings has no watcher. Restart ArchCode, or make a Settings save against the current disk revision, to load it.

A root Lead Session or Composer selection affects its next Execution. Each active
run span retains its selected model, merged options, Profile identity, and
model-runtime revision for that span's full lifetime. If the same logical
Execution suspends and resumes, its next run span may resolve the current
Session/Profile selection again; it does not create a new Execution. When a new
Execution starts with an invalid requested selection, ArchCode tries a valid
Session override and then the current validated Profile default. Child Sessions
retain the Profile chosen in their immutable delegation request. ArchCode never
automatically substitutes another model after a model call fails.
