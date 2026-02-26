import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { luxSearch, luxAskExpert } from '../../../lib/lux-tools';
import { SYSTEM_PROMPT } from '../../../lib/system-prompt';

const anthropic = createAnthropic();

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: SYSTEM_PROMPT,
    messages,
    tools: {
      lux_search: luxSearch,
      lux_ask_expert: luxAskExpert,
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
