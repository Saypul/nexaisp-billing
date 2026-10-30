import React, {useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {flexRender, getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable} from '@tanstack/react-table';
import {ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns3, Download, Rows3, Search, X} from 'lucide-react';
import {downloadCsv, stamp} from '../lib/csv.js';
import {num} from '../lib/format.js';
import {Empty} from './ui.jsx';

// Definisi kolom ringkas. `value` dipakai untuk sort, pencarian, dan CSV; `cell` untuk tampilan.
export function col(id, header, value, {cell, align, csv, hidden, sort = true, width} = {}) {
  return {
    id,
    header,
    accessorFn: row => value(row) ?? '',
    cell: cell ? ({row}) => cell(row.original) : ({getValue}) => getValue() === '' ? '—' : getValue(),
    enableSorting: sort,
    sortingFn: align === 'num' ? 'basic' : 'alphanumeric',
    meta: {align, csv: csv === undefined ? value : csv, hidden, width},
  };
}

export function actionsCol(render) {
  return {id: 'actions', header: '', enableSorting: false, enableHiding: false, cell: ({row}) => <div className="row-actions" onClick={e => e.stopPropagation()}>{render(row.original)}</div>, meta: {csv: false, align: 'end'}};
}

const readPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const writePref = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* preferensi opsional */ } };

const defaultText = row => Object.values(row).filter(v => v !== null && typeof v !== 'object').join(' ');

/**
 * Tabel data untuk volume besar: pencarian, filter facet (tersinkron ke URL), sort,
 * paginasi, pilihan kolom, kepadatan baris, seleksi massal, dan ekspor CSV.
 */
export default function DataTable({
  id, data, columns, facets = [], searchText = defaultText, searchPlaceholder = 'Cari…',
  exportName, onRowClick, rowLabel, selectable = false, bulkActions, initialSort = [],
  emptyTitle, emptyDesc, summary, syncUrl = true, toolbar, pageSize: initialPageSize = 25,
}) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => (syncUrl && params.get('q')) || '');
  const [facetValues, setFacetValues] = useState(() => Object.fromEntries(facets.map(f => [f.id, (syncUrl && params.get(f.id)) || ''])));
  const [sorting, setSorting] = useState(initialSort);
  const [rowSelection, setRowSelection] = useState({});
  const [density, setDensity] = useState(() => readPref('nx_density', 'comfortable'));
  const [columnVisibility, setColumnVisibility] = useState(() => readPref('nx_cols_' + id, Object.fromEntries(columns.filter(c => c.meta?.hidden).map(c => [c.id, false]))));
  const [pagination, setPagination] = useState({pageIndex: 0, pageSize: readPref('nx_pagesize', initialPageSize)});
  const searchRef = useRef(null);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => writePref('nx_cols_' + id, columnVisibility), [id, columnVisibility]);

  // Sinkron dua arah dengan URL: filter dapat dibagikan sebagai tautan, dan tautan
  // ke halaman yang sama (mis. dari kartu ringkasan) memperbarui filter tanpa remount.
  const written = useRef(null);
  useEffect(() => {
    if (!syncUrl) return;
    setParams(prev => {
      const next = new URLSearchParams(prev);
      search ? next.set('q', search) : next.delete('q');
      facets.forEach(f => (facetValues[f.id] ? next.set(f.id, facetValues[f.id]) : next.delete(f.id)));
      written.current = next.toString();
      return next.toString() === prev.toString() ? prev : next;
    }, {replace: true});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, facetValues, syncUrl]);
  useEffect(() => {
    if (!syncUrl || written.current === null || params.toString() === written.current) return;
    setSearch(params.get('q') || '');
    setFacetValues(Object.fromEntries(facets.map(f => [f.id, params.get(f.id) || ''])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, syncUrl]);

  // Tekan "/" untuk langsung ke kotak pencarian tabel.
  useEffect(() => {
    const onKey = e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || /input|textarea|select/i.test(e.target.tagName) || document.body.classList.contains('modal-open')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const textOf = useMemo(() => {
    const cache = new WeakMap();
    return row => {
      let s = cache.get(row);
      if (s === undefined) { s = String(searchText(row)).toLowerCase(); cache.set(row, s); }
      return s;
    };
  }, [searchText]);

  const facetOptions = useMemo(() => facets.map(f => {
    const counts = new Map();
    if (f.match) f.options.forEach(([v]) => counts.set(v, data.filter(row => f.match(row, v)).length));
    else for (const row of data) { const v = f.value(row); if (v !== null && v !== undefined && v !== '') counts.set(v, (counts.get(v) || 0) + 1); }
    const values = f.options ? f.options.map(([v]) => v) : [...counts.keys()].sort().reverse();
    const labels = new Map(f.options || []);
    return {...f, choices: values.map(v => [v, labels.get(v) ?? (f.label ? f.label(v) : v), counts.get(v) || 0])};
  }), [data, facets]);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const active = facets.filter(f => facetValues[f.id]);
    return data.filter(row => active.every(f => (f.match ? f.match(row, facetValues[f.id]) : String(f.value(row)) === facetValues[f.id])) && (!q || textOf(row).includes(q)));
  }, [data, facets, facetValues, deferredSearch, textOf]);

  useEffect(() => setPagination(p => (p.pageIndex ? {...p, pageIndex: 0} : p)), [deferredSearch, facetValues]);

  const allColumns = useMemo(() => !selectable ? columns : [{
    id: 'select', enableSorting: false, enableHiding: false, meta: {csv: false, width: '2.5rem'},
    header: ({table}) => <input type="checkbox" aria-label="Pilih semua baris yang terfilter" checked={table.getIsAllRowsSelected()} ref={el => { if (el) el.indeterminate = table.getIsSomeRowsSelected(); }} onChange={table.getToggleAllRowsSelectedHandler()}/>,
    cell: ({row}) => <input type="checkbox" aria-label="Pilih baris" checked={row.getIsSelected()} disabled={!row.getCanSelect()} onClick={e => e.stopPropagation()} onChange={row.getToggleSelectedHandler()}/>,
  }, ...columns], [columns, selectable]);

  const table = useReactTable({
    data: filtered,
    columns: allColumns,
    state: {sorting, rowSelection, columnVisibility, pagination},
    getRowId: row => String(row.id),
    enableRowSelection: selectable,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: updater => setPagination(p => {
      const next = typeof updater === 'function' ? updater(p) : updater;
      if (next.pageSize !== p.pageSize) writePref('nx_pagesize', next.pageSize);
      return next;
    }),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
  });

  const selectedIds = new Set(Object.keys(rowSelection).filter(k => rowSelection[k]));
  const selectedRows = data.filter(r => selectedIds.has(String(r.id)));
  const sortedRows = table.getPrePaginationRowModel().rows;
  const pageRows = table.getRowModel().rows;
  const {pageIndex, pageSize} = table.getState().pagination;
  const start = filtered.length ? pageIndex * pageSize + 1 : 0;
  const end = Math.min(filtered.length, (pageIndex + 1) * pageSize);
  const activeFilters = facets.some(f => facetValues[f.id]) || search;

  const exportCsv = () => {
    const cols = table.getVisibleLeafColumns().filter(c => c.columnDef.meta?.csv);
    const source = selectedRows.length ? selectedRows : sortedRows.map(r => r.original);
    downloadCsv(`${exportName}-${stamp()}.csv`, cols.map(c => c.columnDef.header), source.map(row => cols.map(c => c.columnDef.meta.csv(row))));
  };

  const clearFilters = () => { setSearch(''); setFacetValues(Object.fromEntries(facets.map(f => [f.id, '']))); };

  return (
    <div className={'datatable ' + density}>
      <div className="dt-toolbar">
        <label className="dt-search">
          <Search size={15} aria-hidden="true"/>
          <input ref={searchRef} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder}/>
          <kbd aria-hidden="true">/</kbd>
        </label>
        {facetOptions.map(f => (
          <label key={f.id} className={'dt-facet ' + (facetValues[f.id] ? 'set' : '')}>
            <span>{f.title}</span>
            <select value={facetValues[f.id]} onChange={e => setFacetValues(v => ({...v, [f.id]: e.target.value}))}>
              <option value="">Semua</option>
              {f.choices.map(([v, label, count]) => <option key={v} value={v}>{label} ({num(count)})</option>)}
            </select>
          </label>
        ))}
        {activeFilters && <button type="button" className="link-btn" onClick={clearFilters}><X size={13}/> Reset filter</button>}
        <div className="dt-tools">
          {toolbar}
          <details className="dt-menu">
            <summary className="icon-btn" aria-label="Atur kolom" title="Atur kolom"><Columns3 size={17}/></summary>
            <div className="dt-menu-panel">
              <b>Kolom</b>
              {table.getAllLeafColumns().filter(c => c.getCanHide()).map(c => (
                <label key={c.id}><input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()}/>{c.columnDef.header}</label>
              ))}
            </div>
          </details>
          <button type="button" className="icon-btn" aria-label="Ubah kepadatan baris" title={density === 'compact' ? 'Baris longgar' : 'Baris rapat'} onClick={() => { const d = density === 'compact' ? 'comfortable' : 'compact'; setDensity(d); writePref('nx_density', d); }}><Rows3 size={17}/></button>
          {exportName && <button type="button" className="btn secondary small" onClick={exportCsv} disabled={!filtered.length}><Download size={14}/>{selectedRows.length ? `CSV (${num(selectedRows.length)})` : 'CSV'}</button>}
        </div>
      </div>

      {selectable && selectedRows.length > 0 && (
        <div className="dt-bulk" role="region" aria-label="Aksi massal">
          <b>{num(selectedRows.length)} dipilih</b>
          {bulkActions?.(selectedRows, () => setRowSelection({}))}
          <button type="button" className="link-btn" onClick={() => setRowSelection({})}>Batalkan pilihan</button>
        </div>
      )}

      <div className="dt-scroll">
        <table>
          <thead>
            {table.getHeaderGroups().map(group => (
              <tr key={group.id}>
                {group.headers.map(h => {
                  const sorted = h.column.getIsSorted();
                  const meta = h.column.columnDef.meta || {};
                  return (
                    <th key={h.id} className={meta.align ? 'a-' + meta.align : ''} style={meta.width ? {width: meta.width} : undefined} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {h.column.getCanSort() ? (
                        <button type="button" className="th-sort" onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === 'asc' ? <ArrowUp size={12}/> : sorted === 'desc' ? <ArrowDown size={12}/> : <ArrowUpDown size={12} className="faint"/>}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {pageRows.length ? pageRows.map(row => (
              <tr key={row.id} className={(onRowClick ? 'clickable ' : '') + (row.getIsSelected() ? 'selected' : '')}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={onRowClick ? e => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row.original); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick && rowLabel ? rowLabel(row.original) : undefined}>
                {row.getVisibleCells().map(cell => {
                  const align = cell.column.columnDef.meta?.align;
                  return <td key={cell.id} className={align ? 'a-' + align : ''}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                })}
              </tr>
            )) : (
              <tr><td colSpan={table.getVisibleLeafColumns().length}>
                {data.length && activeFilters ? <Empty title="Tidak ada yang cocok" desc="Ubah kata kunci atau reset filter."/> : <Empty title={emptyTitle} desc={emptyDesc}/>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="dt-foot">
        <div className="dt-summary">{summary ? summary(filtered) : null}</div>
        <div className="dt-pager">
          <label>Baris
            <select value={pageSize} onChange={e => table.setPageSize(Number(e.target.value))}>
              {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span className="dt-range">{num(start)}–{num(end)} dari {num(filtered.length)}{filtered.length !== data.length ? ` (total ${num(data.length)})` : ''}</span>
          <button type="button" className="icon-btn" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} aria-label="Halaman pertama"><ChevronsLeft size={16}/></button>
          <button type="button" className="icon-btn" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Halaman sebelumnya"><ChevronLeft size={16}/></button>
          <button type="button" className="icon-btn" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Halaman berikutnya"><ChevronRight size={16}/></button>
          <button type="button" className="icon-btn" onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()} aria-label="Halaman terakhir"><ChevronsRight size={16}/></button>
        </div>
      </div>
    </div>
  );
}
