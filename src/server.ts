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
}

type Site = { nome: string; zoneId: string };

// Apelidos: palavras da pergunta -> parte do nome do domínio.
// Para um site novo, basta liberar a zona no token; o apelido é opcional
// (o agente também reconhece o próprio nome do domínio na pergunta).
const APELIDOS: Array<{ pergunta: RegExp; dominio: RegExp }> = [
  { pergunta: /salgad|edilene/, dominio: /salgaderia/ },
  { pergunta: /ciss|selva|sobreviv|starlink|spot ?x|pirotecni/, dominio: /ciss/ },
  { pergunta: /florescer/, dominio: /florescer/ },
  { pergunta: /manaus|decora/, dominio: /manaus/ },
];

export class MyAgent extends Agent<Env> {
  cfHeaders() {
    return {
      Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  // Lista automaticamente todos os sites que o token tem permissão de ver.
  async listSites(): Promise<Site[] | { erro: string; detalhes: unknown }> {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/zones?per_page=50",
      { headers: this.cfHeaders() }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui listar os sites da conta.", detalhes: data.errors };
    return (data.result ?? []).map((z: any) => ({ nome: z.name, zoneId: z.id }));
  }

  pickSites(lower: string, sites: Site[]): Site[] {
    const escolhidos = new Set<Site>();
    for (const site of sites) {
      const primeiraParte = site.nome.split(".")[0];
      if (lower.includes(site.nome) || lower.includes(primeiraParte)) escolhidos.add(site);
    }
    for (const apelido of APELIDOS) {
      if (!apelido.pergunta.test(lower)) continue;
      for (const site of sites) {
        if (apelido.dominio.test(site.nome)) escolhidos.add(site);
      }
    }
    return [...escolhidos];
  }

  async getBotFightMode(zoneId: string) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/bot_management`,
      { headers: this.cfHeaders() }
    );
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui consultar o Bot Fight Mode.", detalhes: data.errors };
    return { botFightModeAtivado: data.result?.fight_mode ?? null };
  }

  async setBotFightMode(zoneId: string, value: boolean) {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/bot_management`;
    // A Cloudflare só aceita PUT aqui. Reenvia a configuração atual para não apagar
    // nenhuma outra opção, mudando apenas o Bot Fight Mode.
    const atual: any = await (await fetch(url, { headers: this.cfHeaders() })).json();
    const body: Record<string, unknown> = {};
    for (const campo of ["enable_js", "ai_bots_protection", "crawler_protection", "is_robots_txt_managed"]) {
      if (atual?.result && campo in atual.result) body[campo] = atual.result[campo];
    }
    body.fight_mode = value;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.cfHeaders(),
      body: JSON.stringify(body),
    });
    const data: any = await res.json();
    if (!data.success) return { erro: "Não consegui alterar o Bot Fight Mode.", detalhes: data.errors };
    return { botFightModeAtivado: data.result?.fight_mode ?? value, acao: value ? "ativado agora" : "desativado agora" };
  }

  async getSecuritySettings(zoneId: string) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings`,
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

  async setAlwaysUseHttps(zoneId: string, on: boolean) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/always_use_https`,
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

  async checkSite(site: Site, wantsBot: boolean, wantsSecurity: boolean, podeCorrigir: boolean) {
    const dados: Record<string, unknown> = { site: site.nome };

    if (wantsBot) {
      const status: any = await this.getBotFightMode(site.zoneId);
      dados.botFightMode = status;
      if (podeCorrigir && status.botFightModeAtivado === false) {
        dados.acaoBotFightMode = await this.setBotFightMode(site.zoneId, true);
      }
    }

    if (wantsSecurity) {
      const status: any = await this.getSecuritySettings(site.zoneId);
      dados.seguranca = status;
      if (podeCorrigir && status.alwaysUseHttpsAtivado === false) {
        dados.acaoAlwaysUseHttps = await this.setAlwaysUseHttps(site.zoneId, true);
      }
    }

    return dados;
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
    const wantsFix = /ativ|corrig|corrij|conserta|conserte|arruma|liga|resolv/.test(lower);
    const wantsAll = /todos|todas|meus sites|cada site/.test(lower);
    let wantsBot = /bot|robô|robo/.test(lower);
    let wantsSecurity = /seguran|ssl|https|criptografia/.test(lower);

    // Pergunta genérica ("como estão meus sites?") -> confere tudo.
    if (!wantsBot && !wantsSecurity) {
      wantsBot = true;
      wantsSecurity = true;
    }

    const lista = await this.listSites();
    let dados: Record<string, unknown>;

    if (!Array.isArray(lista)) {
      dados = lista;
    } else {
      const citados = this.pickSites(lower, lista);
      const alvo = citados.length > 0 && !wantsAll ? citados : lista;
      // Só corrige sozinho quando o site foi citado pelo nome, ou quando pediu "todos".
      const podeCorrigir = wantsFix && (citados.length > 0 || wantsAll);

      const resultados = [];
      for (const site of alvo) {
        resultados.push(await this.checkSite(site, wantsBot, wantsSecurity, podeCorrigir));
      }

      dados = {
        sitesMonitorados: lista.map((s) => s.nome),
        resultados,
        ...(wantsFix && !podeCorrigir
          ? { aviso: "Pediu correção sem dizer qual site: só consultei. Diga o nome do site ou 'todos'." }
          : {}),
      };
    }

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = await tracedAI.generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-fast"),
      maxOutputTokens: 1500,
      system:
        "Você explica em português, de forma simples e direta, o status de segurança de sites na Cloudflare e o que foi corrigido automaticamente, com base apenas nos dados JSON fornecidos. Fale de cada site separadamente, sempre dizendo o domínio. Nunca invente números ou status que não estejam nos dados.",
      prompt: `Pergunta do usuário: "${message}"\n\nDados reais consultados na Cloudflare: ${JSON.stringify(
        dados
      )}\n\nResponda ao usuário explicando o que foi encontrado em cada site e, se alguma ação foi tomada, o que foi feito.`,
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
