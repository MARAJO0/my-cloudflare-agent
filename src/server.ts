import { Agent, routeAgentRequest, type AgentNamespace } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const tracedAI = wrapAISDK(ai, {
  storeMessages: false,
  storeTools: false,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export interface Env {
  MyAgent: AgentNamespace<MyAgent>;
  AI: Ai;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
}

export class MyAgent extends Agent<Env> {
  cfHeaders() {
    return {
      Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  buildTools() {
    return {
      statusDoBotFightMode: ai.tool({
        description:
          "Verifica se o Bot Fight Mode (proteção contra bots) está ativado no site.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/bot_management`,
            { headers: this.cfHeaders() }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui consultar o Bot Fight Mode.", detalhes: data.errors };
          }
          return { botFightModeAtivado: data.result?.fight_mode ?? null };
        },
      }),

      ativarBotFightMode: ai.tool({
        description:
          "ATIVA o Bot Fight Mode (proteção contra bots) no site. Use depois de confirmar que ele estava desativado.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/bot_management`,
            {
              method: "PATCH",
              headers: this.cfHeaders(),
              body: JSON.stringify({ fight_mode: true }),
            }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui ativar o Bot Fight Mode.", detalhes: data.errors };
          }
          return { botFightModeAtivado: data.result?.fight_mode ?? true, acao: "ativado agora" };
        },
      }),

      configuracoesDeSeguranca: ai.tool({
        description:
          "Consulta o nível de segurança, o modo SSL e se 'Always Use HTTPS' está ativado no site.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/settings`,
            { headers: this.cfHeaders() }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui consultar as configurações.", detalhes: data.errors };
          }
          const settings: Array<{ id: string; value: unknown }> = data.result ?? [];
          const find = (id: string) => settings.find((s) => s.id === id)?.value ?? null;
          return {
            nivelDeSeguranca: find("security_level"),
            modoSSL: find("ssl"),
            alwaysUseHttpsAtivado: find("always_use_https") === "on",
          };
        },
      }),

      ativarAlwaysUseHttps: ai.tool({
        description:
          "ATIVA a opção 'Always Use HTTPS', que força o acesso ao site via HTTPS. Use quando estiver desativada.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/settings/always_use_https`,
            {
              method: "PATCH",
              headers: this.cfHeaders(),
              body: JSON.stringify({ value: "on" }),
            }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui ativar o Always Use HTTPS.", detalhes: data.errors };
          }
          return { alwaysUseHttpsAtivado: true, acao: "ativado agora" };
        },
      }),
    };
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    let message: string | null = null;

    if (request.method === "GET") {
      const url = new URL(request.url);
      message = url.searchParams.get("message");
    } else if (request.method === "POST") {
      const body = await request.json<{ message?: string }>();
      message = body.message ?? null;
    }

    if (!message) {
      return new Response(
        "Manda uma mensagem: adicione ?message=sua+pergunta na URL, ou faça um POST com { \"message\": \"...\" }",
        { status: 400, headers: corsHeaders }
      );
    }

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = await tracedAI.generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-fast"),
      system:
        "Você monitora e mantém a segurança de um site na Cloudflare. Quando o usuário perguntar sobre bots, segurança, SSL ou HTTPS, primeiro use a ferramenta de consulta correspondente pra checar o status real. Se encontrar algo desativado que tenha uma ferramenta de ativação disponível (Bot Fight Mode ou Always Use HTTPS), avise o que encontrou E já use a ferramenta de ativação pra corrigir, sem precisar perguntar antes. Nunca invente ações que não existem como ferramentas. Sempre explique em português, de forma simples, o que você encontrou e o que fez.",
      prompt: message,
      tools: this.buildTools(),
      stopWhen: ai.stepCountIs(4),
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

    return new Response(result.text, {
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "Not found. Try /agents/my-agent/<conversation-id>?message=oi",
        { status: 404 }
      )
    );
  },
};
