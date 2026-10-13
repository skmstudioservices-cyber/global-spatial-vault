// src/grid.js

/**
 * Render a simple editable grid inside #gridContainer.
 * Data format: [{col1: val1, col2: val2, ...}, ...]
 */
export function renderGrid(data) {
  const container = document.getElementById('gridContainer');
  container.innerHTML = '';

  if (!Array.isArray(data) || data.length === 0) {
    container.textContent = 'No data available.';
    return;
  }

  const columns = Object.keys(data[0]);

  const table = document.createElement('table');
  table.className = 'grid-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  data.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    columns.forEach(col => {
      const td = document.createElement('td');
      td.contentEditable = true;
      td.textContent = row[col] ?? '';
      // Simple change handler – in a real app you would POST to the API.
      td.addEventListener('blur', () => {
        console.log(`Row ${rowIndex} column ${col} changed to`, td.textContent);
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  container.appendChild(table);
}
