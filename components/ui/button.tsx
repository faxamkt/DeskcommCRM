import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button — identidade lima/grafite.
 * Variants:
 *   - primary (default): pílula de PREENCHIMENTO (`--color-accent-fill`): lima
 *     com texto grafite no produto, a cor da marca com frente calculada numa
 *     instalação com marca (lib/branding/css.ts aponta o fill para o accent).
 *   - secondary: pílula neutra sobre superfície rebaixada, ação comum
 *   - ghost: transparente, hover suave (toolbar/inline)
 *   - destructive: error fill (delete/cancel destrutivo)
 *   - outline: alias de secondary com background transparente (compat shadcn)
 *   - link: text-only com underline, na cor de TEXTO do accent (legível)
 *   - default: alias de primary (compat shadcn)
 *
 * Por que o primário NÃO é `bg-accent`: o accent é o papel de texto/borda/anel e
 * no produto é um oliva escuro (4,7:1 sobre o fundo). O lima não lê como texto
 * (1,04:1), mas é ótimo como fundo de botão — quem carrega a leitura é o grafite
 * por cima dele (13,4:1). Ver o bloco "Identidade" no `:root` do globals.css.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-full font-semibold",
    "transition-[background-color,border-color,color,box-shadow,transform]",
    "duration-fast ease-out",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover",
        default:
          "bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover",
        secondary:
          "bg-surface-elevated text-text border border-border hover:border-border-strong hover:bg-surface",
        outline:
          "bg-transparent text-text border border-border hover:border-border-strong hover:bg-surface-elevated",
        ghost:
          "bg-transparent text-text hover:bg-surface-elevated",
        destructive:
          "bg-error text-white hover:brightness-95",
        link:
          "bg-transparent text-accent underline underline-offset-4 decoration-1 hover:decoration-2 h-auto p-0",
      },
      // Alturas de toque: abaixo de `lg` (mesmo corte que o resto da casca
      // usa pra decidir "é celular/tablet, é mouse") toda variante bate os
      // 44px recomendados pra alvo de toque; de `lg:` pra cima, onde quem
      // aciona é cursor, volta pro tamanho compacto original — mudar isso
      // globalmente pro app inteiro em telas grandes infla a densidade sem
      // necessidade nenhuma. `lg` já nascia com 44px e não precisou mudar.
      size: {
        sm: "h-11 px-3 text-xs lg:h-8",
        default: "h-11 px-4 text-sm lg:h-9",
        md: "h-11 px-4 text-sm lg:h-9",
        lg: "h-11 px-6 text-sm",
        icon: "h-11 w-11 lg:h-9 lg:w-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
