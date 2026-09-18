---
impacto: nada_mudou
secao: corrigido
titulo: O laço rápido de eventos (event_log) volta a registrar todos os handlers no worker
---

O import estático de `renderLgpdPdf` em `workers/lgpd-export-worker.ts` puxava
`@react-pdf/hyphenate`, cujo `exports` com wildcard o resolvedor que o `tsx`
usa não resolve (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — e como
`lib/event-log/register-handlers.ts` importa todo handler no topo, isso
derrubava `ensureHandlersRegistered()` inteiro. O worker caía pro cron de
1×/min pra TODO evento genérico (mídia, follow-up, automações, LGPD, push),
em vez do laço rápido (2-10s). Import adiado para o ponto de uso: os outros
11 handlers voltam ao laço rápido. A exportação de PDF da LGPD em si segue
com um problema separado sob investigação — pode falhar quando efetivamente
invocada.
