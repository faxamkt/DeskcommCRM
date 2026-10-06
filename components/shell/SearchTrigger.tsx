"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      {/* Pílula larga sobre o fundo, como a busca da identidade: no desktop ela
          ocupa a faixa central inteira e convida a digitar; no celular encolhe
          para o ícone, que é o que cabe ao lado do menu e do avatar. */}
      <Button
        variant="ghost"
        size="sm"
        className="w-11 justify-center gap-3 bg-surface px-0 font-normal text-muted-foreground hover:bg-surface md:w-full md:justify-start md:px-5 lg:h-10"
        onClick={() => setOpen(true)}
        aria-label={t("Buscar...")}
      >
        <MagnifyingGlass size={16} aria-hidden />
        <span className="hidden md:inline">{t("Buscar...")}</span>
        <kbd className="ml-auto hidden rounded-md border bg-surface-elevated px-1.5 py-0.5 text-[10px] md:inline">⌘K</kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
