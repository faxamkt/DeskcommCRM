"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    // `h-14` é parcela do cálculo de altura do Inbox (InboxLayout.tsx) — a
    // altura não muda; o que mudou é que a barra deixou de ser uma faixa com
    // borda e virou o fundo cinza com os controles em pílula por cima.
    // `pt-3` alinha o topo das pílulas ao topo da barra lateral flutuante.
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 bg-background/90 px-3 pt-3 backdrop-blur md:gap-3 md:pr-6 md:pl-4">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      <div className="flex min-w-0 flex-1 justify-center md:max-w-xl">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
