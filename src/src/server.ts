import { Agent, routeAgentRequest, type AgentNamespace } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createOpenAI } from "@ai-sdk/openai";

const tracedAI = wrapAISDK(ai, {
  storeMessages: false,
  storeTools: false,
});

export interface Env {
  MyAgent: AgentNamespace<MyAgent>;
  OPENAI_API_KEY: string;
}

export class MyAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Send a POST with { \"message\": \"...\" }", {
        status: 405,
      });
    }

    const { message } = await request.json<{ message: string }>();
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });

    const result = await tracedAI.generateText({
      model: openai("gpt-4o-mini"),
      prompt: message,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "my-agent.chat",
        metadata: {
          agentName: "my-cloudflare-agent",
          agentId: this.name,
          conversationId: this.name,
        },
      },
    });

    return Response.json({ reply: result.text });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "Not found. POST to /agents/my-agent/<conversation-id> to chat.",
        { status: 404 }
      )
    );
  },
};
