"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  return (
    <div className="flex min-h-screen w-full bg-background">
      {/*
        A barra lateral FLUTUA: é um cartão arredondado com 12px de respiro do
        fundo (identidade lima/grafite). O respiro mora AQUI, no invólucro, e não
        na coluna de conteúdo — o Inbox calcula a própria altura a partir do
        `h-14` da TopBar e do `py-6` do <main> (components/inbox/InboxLayout.tsx),
        e margem vertical na coluna entraria nessa conta sem ninguém ver.
      */}
      <div className="hidden md:block md:py-3 md:pl-3">
        <Sidebar collapsed={sidebarCollapsed} />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <TopBar />
        {/* `py-6` é parcela do cálculo de altura do Inbox — o horizontal é livre:
            no celular a margem cai para 12px, que é o que a tela de 390px pede. */}
        <main className="flex-1 overflow-auto px-3 py-6 md:pr-6 md:pl-4">{children}</main>
      </div>
    </div>
  );
}
