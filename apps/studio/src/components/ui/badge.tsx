import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "success" | "warning" | "destructive";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        variant === "default" && "border-border bg-secondary text-secondary-foreground",
        variant === "success" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        variant === "warning" && "border-amber-200 bg-amber-50 text-amber-800",
        variant === "destructive" && "border-red-200 bg-red-50 text-red-800",
        className,
      )}
      {...props}
    />
  );
}
