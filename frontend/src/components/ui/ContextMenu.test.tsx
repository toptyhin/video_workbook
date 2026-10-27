import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';

function renderMenu(items: ContextMenuItem[], onClose = vi.fn()) {
  render(<ContextMenu x={20} y={20} items={items} onClose={onClose} label="тест" />);
  return { onClose };
}

describe('ContextMenu', () => {
  it('рисует подменю порталом вне корневого меню (не обрезается overflow)', async () => {
    renderMenu([
      {
        id: 'move',
        label: 'Переместить в папку',
        children: [{ id: 'dest', label: 'Папка А' }],
      },
    ]);

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Переместить в папку' }));
    const child = await screen.findByRole('menuitem', { name: 'Папка А' });

    // Подменю не должно быть потомком .vl-context-menu (иначе его режет overflow-y).
    expect(child.closest('.vl-context-menu')).toBeNull();
    expect(document.querySelector('[data-submenu="true"]')).not.toBeNull();
  });

  it('клик по пункту подменю выбирает его и закрывает меню', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderMenu(
      [
        {
          id: 'copy',
          label: 'Скопировать в папку',
          children: [{ id: 'dest', label: 'Папка Б', onSelect }],
        },
      ],
      onClose,
    );

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Скопировать в папку' }));
    const child = await screen.findByRole('menuitem', { name: 'Папка Б' });

    // mousedown внутри портала не должен закрыть меню до клика.
    fireEvent.mouseDown(child);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(child);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик вне меню и Escape закрывают меню', () => {
    const onClose = vi.fn();
    renderMenu([{ id: 'plain', label: 'Простое' }], onClose);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
