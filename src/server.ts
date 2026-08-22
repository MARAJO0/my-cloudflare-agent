import { Agent, routeAgentRequest, type AgentNamespace } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";

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

  async getBotFightMode() {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/bot_management`,
      { headers: this.cfHeaders() }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui consultar o Bot Fight Mode.", detalhes: data.errors };
    return { botFightModeAtivado: data.result?.fight_mode ?? null };
  }

  async setBotFightMode(value: boolean) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/bot_management`,
      {
        method: "PATCH",
        headers: this.cfHeaders(),
        body: JSON.stringify({ fight_mode: value }),
      }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui alterar o Bot Fight Mode.", detalhes: data.errors };
    return { botFightModeAtivado: data.result?.fight_mode ?? value, acao: value ? "ativado agora" : "desativado agora" };
  }

  async getSecuritySettings() {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/settings`,
      { headers: this.cfHeaders() }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui consultar as configurações.", detalhes: data.errors };
    const settings: Array<{ id: string; value: unknown }> = data.result ?? [];
    const find = (id: string) => settings.find((s) => s.id === id)?.value ?? null;
    return {
      nivelDeSeguranca: find("security_level"),
      modoSSL: find("ssl"),
      alwaysUseHttpsAtivado: find("always_use_https") === "on",
    };
  }

  async setAlwaysUseHttps(on: boolean) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/settings/always_use_https`,
      {
        method: "PATCH",
        headers: this.cfHeaders(),
        body: JSON.stringify({ value: on ? "on" : "off" }),
      }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui alterar o Always Use HTTPS.", detalhes: data.errors };
    return { alwaysUseHttpsAtivado: on, acao: on ? "ativado agora" : "desativado agora" };
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

    const lower = message.toLowerCase();
    const wantsBot = /bot|robô|robo/.test(lower);
    const wantsSecurity = /seguran|ssl|https|criptografia/.test(lower);
    const wantsFix = /ativ|corrij|conserta|conserte|arruma|liga|resolv/.test(lower);

    const dados: Record<string, unknown> = {};

    if (wantsBot) {
      const status: any = await this.getBotFightMode();
      dados.botFightMode = status;
      if (wantsFix && status.botFightModeAtivado === false) {
        dados.acaoBotFightMode = await this.setBotFightMode(true);
      }
    }

    if (wantsSecurity) {
      const status: any = await this.getSecuritySettings();
      dados.seguranca = status;
      if (wantsFix && status.alwaysUseHttpsAtivado === false) {
        dados.acaoAlwaysUseHttps = await this.setAlwaysUseHttps(true);
      }
    }

    if (!wantsBot && !wantsSecurity) {
      dados.aviso = "Não identifiquei se a pergunta era sobre bots ou sobre segurança/SSL/HTTPS.";
    }

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = await tracedAI.generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-fast"),
      system:
        "Você explica em português, de forma simples e direta, o status de segurança de um site na Cloudflare e o que foi corrigido automaticamente, com base apenas nos dados JSON fornecidos. Nunca invente números ou status que não estejam nos dados.",
      prompt: `Pergunta do usuário: "${message}"\n\nDados reais consultados na Cloudflare: ${JSON.stringify(
        dados
      )}\n\nResponda ao usuário explicando o que foi encontrado e, se alguma ação foi tomada, o que foi feito.`,
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
