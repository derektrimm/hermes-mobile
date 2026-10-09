import assert from 'node:assert/strict'
import { test } from 'node:test'

import { accountLabel, effortLabel, modelLabel, providerLabel } from '../src/lib/labels.ts'

// Every model id a set of Hermes accounts offered on 2026-10-09, with the name it must show.
const MODELS: Array<[string, string]> = [
  ['claude-fable-5.1', 'Fable 5.1'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-5-20251101', 'Opus 4.5'],
  ['claude-opus-4-20250514', 'Opus 4'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
  ['claude-sonnet-4.6', 'Sonnet 4.6'],
  ['claude-opus-5-5[1m]', 'Opus 5.5 1M'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-astra-900k', 'GPT-6 Astra 900K'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.4-mini', 'GPT-5.4 Mini'],
  ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'],
  ['gpt-5-mini', 'GPT-5 Mini'],
  ['gpt-4o', 'GPT-4o'],
  ['gpt-4o-mini', 'GPT-4o Mini'],
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
  ['gemini-3-6-flash', 'Gemini 3.6 Flash'],
  ['gemini-3-5-flash-lite', 'Gemini 3.5 Flash Lite'],
  ['grok-4.7', 'Grok 4.7'],
  ['grok-4-7', 'Grok 4.7'],
  ['grok-4.20-0309-reasoning', 'Grok 4.20 Reasoning'],
  ['grok-4.20-0309-non-reasoning', 'Grok 4.20 Non-Reasoning'],
  ['grok-4.20-multi-agent-0309', 'Grok 4.20 Multi-Agent'],
  ['grok-build-0.1', 'Grok Build 0.1'],
  ['grok-composer-2.5-fast', 'Grok Composer 2.5 Fast'],
  ['grok-4.7-build-fast', 'Grok 4.7 Build Fast'],
  ['z-ai-glm-5-3', 'GLM 5.3'],
  ['zai-org-glm-5-2', 'GLM 5.2'],
  ['z-ai-glm-5v-turbo', 'GLM 5V Turbo'],
  ['olafangensan-glm-4.7-flash-heretic', 'GLM 4.7 Flash Heretic'],
  ['venice-uncensored-1-2', 'Venice Uncensored 1.2'],
  ['venice-uncensored-role-play', 'Venice Uncensored Role-Play'],
  ['qwen-3-8-2-4t-a95b', 'Qwen 3.8 2.4T A95B'],
  ['qwen-3-8-27b', 'Qwen 3.8 27B'],
  ['qwen-3-8-max', 'Qwen 3.8 Max']
]

test('every model on the accounts reads as a product name', () => {
  for (const [id, label] of MODELS) {
    assert.equal(modelLabel(id), label, id)
  }
})

test('providers are named for what they are, without account details', () => {
  assert.equal(providerLabel('anthropic', 'Anthropic'), 'Anthropic API')
  assert.equal(providerLabel('openai-codex', 'ChatGPT or Codex Subscription'), 'ChatGPT Subscription')
  assert.equal(providerLabel('grok-acp', 'Grok (subscription)'), 'Grok Subscription')
  assert.equal(providerLabel('claude2', 'Claude (claude2, someone)'), 'Claude 2 Subscription')
  assert.equal(providerLabel('xai', 'xAI'), 'xAI API')
  assert.equal(providerLabel('some-router', 'Some Router (team)'), 'Some Router')
})

test('effort levels and accounts', () => {
  assert.deepEqual(
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effortLabel),
    ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']
  )
  assert.equal(accountLabel('claude2', 'Claude 2'), 'Claude 2')
  assert.equal(accountLabel('codex2', null), 'Codex 2')
})
