"use client";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useBulkRedactOrgContacts } from "@/hooks/connections/useBulkRedactOrgContacts";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const CONFIRM_TEXT = "APAGAR HISTÓRICO";

/**
 * Zona de perigo de Conexões — redige (não deleta a organização) TODO contato
 * não-anonimizado da org ativa. Pensado pro caso "o número conectado aqui
 * estava errado, o histórico não pertence a esta conta". Mesma cascata do
 * botão individual (ver AnonymizeDialog), em lote: cria e já aprova a
 * solicitação LGPD de cada contato — o worker processa em segundos.
 */
export function ApagarHistoricoDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const bulk = useBulkRedactOrgContacts();
  const [step, setStep] = useState<1 | 2>(1);
  const [justification, setJustification] = useState("");
  const [confirm, setConfirm] = useState("");

  function reset() {
    setStep(1);
    setJustification("");
    setConfirm("");
  }

  async function handleSubmit() {
    try {
      const res = await bulk.mutateAsync({ justification: justification.trim() });
      const { requested, skipped_already_requested } = res.data;
      if (requested === 0 && skipped_already_requested === 0) {
        toast.info(t("Nenhum contato pra redigir — esta organização já está limpa."));
      } else if (requested === 0) {
        toast.info(t("Todos os contatos já tinham solicitação de redação em andamento."));
      } else {
        toast.success(
          t("{n} contato(s) marcado(s) para redação. O conteúdo some em segundos.").replace(
            "{n}",
            String(requested),
          ),
        );
      }
      reset();
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-error-fg">
            {t("Apagar histórico de conversas desta organização (LGPD)")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Ação irreversível. Redige TODO contato não-anonimizado desta organização: mensagens viram \"[mensagem anonimizada]\", mídia é apagada do Storage, e o cadastro vira \"Cliente Anonimizado #N\". A organização em si continua ativa — pipeline, agente e conexões não são afetados.",
            )}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-redact-justif">{t("Justificativa (mínimo 10 caracteres)")}</Label>
              <Textarea
                id="bulk-redact-justif"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder={t("Ex.: número anterior errado, histórico não pertence a esta conta")}
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                {justification.trim().length}/10 {t("caracteres mínimos")}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                {t("Cancelar")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setStep(2)}
                disabled={justification.trim().length < 10}
              >
                {t("Continuar")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-error-fg/30 bg-error-bg p-3 text-sm text-error-fg">
              {t("Para confirmar, digite")} <strong>{CONFIRM_TEXT}</strong> {t("abaixo.")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-redact-confirm">{t("Confirmação")}</Label>
              <Input
                id="bulk-redact-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={CONFIRM_TEXT}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep(1)} disabled={bulk.isPending}>
                {t("Voltar")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleSubmit}
                disabled={confirm !== CONFIRM_TEXT || bulk.isPending}
              >
                {bulk.isPending ? t("Apagando…") : t("Apagar histórico permanentemente")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
