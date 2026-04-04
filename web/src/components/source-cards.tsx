import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

interface SourceCardsProps {
  cards: string[]
  activeCard: string | null
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onCardClick: (slug: string) => void
}

export function SourceCards({
  cards,
  activeCard,
  collapsed,
  onCollapsedChange,
  onCardClick,
}: SourceCardsProps) {
  if (cards.length === 0) return null

  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => onCollapsedChange(!open)}
      className="mb-[18px]"
    >
      {collapsed ? (
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="p-0 h-auto text-[#2e2418] font-mono text-[9px] tracking-[0.1em] hover:text-[#6a5030] hover:bg-transparent"
            />
          }
        >
          <span className="flex gap-[3px] mr-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="w-2.5 h-0.5 bg-[#222] rounded-sm" />
            ))}
          </span>
          {cards.length} sources
        </CollapsibleTrigger>
      ) : (
        <>
          <CollapsibleContent>
            <div className="flex flex-wrap gap-[5px] mb-[7px]">
              {cards.map((slug, i) => (
                <Badge
                  key={slug}
                  variant="outline"
                  onClick={() => onCardClick(slug)}
                  style={{ animationDelay: `${i * 40}ms` }}
                  className={`cursor-pointer rounded-sm h-auto px-[11px] py-[5px] font-mono text-[9.5px] tracking-[0.06em] whitespace-nowrap animate-[card-in_0.26s_ease_both] transition-all ${
                    activeCard === slug
                      ? "border-gold-dim text-gold bg-[#100e08]"
                      : "bg-ink-raised border-ink-border text-card-foreground hover:border-gold-dim hover:text-gold"
                  }`}
                >
                  {slug}
                </Badge>
              ))}
            </div>
          </CollapsibleContent>

          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="p-0 h-auto mt-[7px] text-[#2e2418] font-mono text-[9px] tracking-[0.1em] hover:text-[#6a5030] hover:bg-transparent"
              />
            }
          >
            collapse sources
          </CollapsibleTrigger>
        </>
      )}
    </Collapsible>
  )
}
