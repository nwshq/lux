export type AiBackend = 'claude' | 'pi';
export type AiThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AiDefaultsEnv {
  [key: string]: string | undefined;
}

export interface AiDefaults {
  model: string;
  backend: AiBackend;
  provider?: string;
  thinking?: AiThinking;
}

const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_BACKEND: AiBackend = 'pi';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_THINKING: AiThinking = 'high';

function normalizeBackend(value: string | undefined): AiBackend | undefined {
  if (value === 'claude' || value === 'pi') return value;
  return undefined;
}

function normalizeThinking(value: string | undefined): AiThinking | undefined {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

export function inferBackendFromModel(model: string): AiBackend {
  if (model.startsWith('claude-') || model.startsWith('anthropic/')) {
    return 'claude';
  }
  return 'pi';
}

export function resolveAiDefaults(env: AiDefaultsEnv = process.env): AiDefaults {
  const model = env.LUX_MODEL ?? DEFAULT_MODEL;
  const backend =
    normalizeBackend(env.LUX_BACKEND) ?? inferBackendFromModel(model) ?? DEFAULT_BACKEND;
  const provider = env.LUX_PROVIDER ?? (backend === 'pi' ? DEFAULT_PROVIDER : undefined);
  const thinking =
    normalizeThinking(env.LUX_THINKING) ?? (backend === 'pi' ? DEFAULT_THINKING : undefined);

  return {
    model,
    backend,
    provider,
    thinking,
  };
}

export function resolveSynthesisDefaults(env: AiDefaultsEnv = process.env): AiDefaults {
  const base = resolveAiDefaults(env);
  const model = env.LUX_SYNTHESIS_MODEL ?? base.model;
  const backend = normalizeBackend(env.LUX_SYNTHESIS_BACKEND) ?? base.backend;
  const provider =
    env.LUX_SYNTHESIS_PROVIDER ??
    (backend === 'pi' ? (base.provider ?? DEFAULT_PROVIDER) : undefined);
  const thinking =
    normalizeThinking(env.LUX_SYNTHESIS_THINKING) ??
    (backend === 'pi' ? (base.thinking ?? DEFAULT_THINKING) : undefined);

  return {
    model,
    backend,
    provider,
    thinking,
  };
}

export function resolveRoutingDefaults(env: AiDefaultsEnv = process.env): AiDefaults {
  const base = resolveAiDefaults(env);
  const model = env.LUX_ROUTING_MODEL ?? base.model;
  const backend = normalizeBackend(env.LUX_ROUTING_BACKEND) ?? inferBackendFromModel(model);
  const provider =
    env.LUX_ROUTING_PROVIDER ??
    (backend === 'pi' ? (base.provider ?? DEFAULT_PROVIDER) : undefined);
  const thinking =
    normalizeThinking(env.LUX_ROUTING_THINKING) ??
    (backend === 'pi' ? (base.thinking ?? DEFAULT_THINKING) : undefined);

  return {
    model,
    backend,
    provider,
    thinking,
  };
}
