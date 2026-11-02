"use client";
import { Menu } from "@base-ui/react/menu";

export function ModelPicker({ models, value, disabled, onChange }: {
  models: readonly string[]; value: string; disabled: boolean; onChange(value: string): void;
}) {
  return <Menu.FilterProvider><Menu.Root>
    <Menu.Trigger disabled={disabled} className="text-button" aria-label="Choose local model">{value || "Ollama unavailable"}</Menu.Trigger>
    <Menu.Portal><Menu.Positioner sideOffset={8}><Menu.Popup className="menu-popup">
      <Menu.Input className="model-search" aria-label="Search local models" placeholder="Find a model…" />
      <Menu.List className="model-list">{models.map((name) => <Menu.Item key={name} label={name} className="menu-item" onClick={() => onChange(name)}>{name}{value === name ? " ✓" : ""}</Menu.Item>)}</Menu.List>
      <Menu.Empty>No matching local models</Menu.Empty>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root></Menu.FilterProvider>;
}
