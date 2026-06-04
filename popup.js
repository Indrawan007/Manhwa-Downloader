// =============================================
// POPUP SCRIPT
// =============================================

let state = 'idle'; // idle | collecting | done
let imageCount = 0;

// -----------------------------------------------
// UI Helpers
// -----------------------------------------------
function showStatus(msg, type = 'info') {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = `status ${type}`;
  el.style.display = 'block';
}

function hideStatus() {
  document.getElementById('statusMsg').style.display = 'none';
}

function updateCount(count) {
  imageCount = count;
  document.getElementById('imageCount').textContent = count;
}

function setState(newState) {
  state = newState;
  
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnScroll = document.getElementById('btnScroll');
  const btnDownload = document.getElementById('btnDownload');
  const statusText = document.getElementById('statusText');
  
  // Reset semua
  [btnStart, btnStop, btnScroll, btnDownload].forEach(b => b.style.display = 'none');
  
  if (newState === 'idle') {
    btnStart.style.display = 'block';
    statusText.textContent = 'Ready';
    statusText.style.color = '#aaa';
  } 
  else if (newState === 'collecting') {
    btnScroll.style.display = 'block';
    btnDownload.style.display = 'block';
    btnStop.style.display = 'block';
    statusText.innerHTML = '<span class="collecting-indicator"></span>Collecting...';
    statusText.style.color = '#e94560';
  }
  else if (newState === 'done') {
    btnStart.style.display = 'block';
    btnDownload.style.display = 'block';
    statusText.textContent = 'Ready to download';
    statusText.style.color = '#27ae60';
  }
  else if (newState === 'downloading') {
    statusText.textContent = 'Downloading...';
    statusText.style.color = '#f39c12';
  }
}

function setScrollProgress(pct) {
  const container = document.getElementById('scrollProgress');
  container.style.display = 'block';
  document.getElementById('scrollPct').textContent = pct + '%';
  document.getElementById('scrollFill').style.width = pct + '%';
  
  if (pct >= 100) {
    setTimeout(() => {
      container.style.display = 'none';
    }, 1000);
  }
}

function setZipProgress(pct) {
  const container = document.getElementById('zipProgress');
  container.style.display = 'block';
  document.getElementById('zipPct').textContent = pct + '%';
  document.getElementById('zipFill').style.width = pct + '%';
  
  if (pct >= 100) {
    setTimeout(() => {
      container.style.display = 'none';
    }, 1000);
  }
}

// -----------------------------------------------
// Get active tab
// -----------------------------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, message);
}

// -----------------------------------------------
// Button Handlers
// -----------------------------------------------
document.getElementById('btnStart').addEventListener('click', async () => {
  try {
    const response = await sendToContent({ type: 'START_COLLECTING' });
    
    if (response.success) {
      setState('collecting');
      updateCount(0);
      document.getElementById('manhwaTitle').textContent = response.title;
      showStatus('Collecting started! Scroll through the page or use Auto-Scroll', 'info');
    }
  } catch(e) {
    showStatus('Error: Cannot connect to page. Refresh and try again.', 'error');
  }
});

document.getElementById('btnStop').addEventListener('click', async () => {
  try {
    const response = await sendToContent({ type: 'STOP_COLLECTING' });
    
    setState('done');
    showStatus(`Stopped. ${response.count} images collected.`, 'success');
  } catch(e) {
    showStatus('Error stopping collection', 'error');
  }
});

document.getElementById('btnScroll').addEventListener('click', async () => {
  const btn = document.getElementById('btnScroll');
  btn.disabled = true;
  btn.textContent = '↕ Scrolling...';
  
  showStatus('Auto-scrolling to trigger lazy loading...', 'info');
  
  try {
    // Mulai scroll
    sendToContent({ type: 'START_SCROLL' });
    
    showStatus('Scrolling done! All images should be loaded.', 'success');
  } catch(e) {
    showStatus('Scroll error: ' + e.message, 'error');
  }
  
  btn.disabled = false;
  btn.textContent = '↕ Auto-Scroll (Lazy Load)';
});

document.getElementById('btnDownload').addEventListener('click', async () => {
  if (imageCount === 0) {
    showStatus('No images collected yet!', 'warning');
    return;
  }
  
  const btn = document.getElementById('btnDownload');
  btn.disabled = true;
  btn.textContent = '⏳ Preparing...';
  
  showStatus('Preparing images...', 'info');
  
  try {
    // Ambil semua blob dari content script
    const response = await sendToContent({ type: 'PREPARE_DOWNLOAD' });
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to prepare images');
    }
    
    if (response.images.length === 0) {
      showStatus('No images to download!', 'warning');
      return;
    }
    
    showStatus(`Creating ZIP for ${response.images.length} images...`, 'info');
    setState('downloading');
    
    // Kirim ke background untuk ZIP
    const zipResponse = await chrome.runtime.sendMessage({
      type: 'CREATE_ZIP',
      images: response.images,
      title: response.title
    });
    
    if (zipResponse.success) {
      showStatus(
        `✅ Downloaded: ${zipResponse.filename} (${zipResponse.imageCount} images)`, 
        'success'
      );
      setState('idle');
      updateCount(0);
    } else {
      throw new Error(zipResponse.error);
    }
    
  } catch(e) {
    showStatus('Download error: ' + e.message, 'error');
    setState(state === 'downloading' ? 'done' : state);
  }
  
  btn.disabled = false;
  btn.textContent = '⬇ Download ZIP';
});

document.getElementById('btnReset').addEventListener('click', async () => {
  try {
    await sendToContent({ type: 'STOP_COLLECTING' });
  } catch(e) {}
  
  setState('idle');
  updateCount(0);
  document.getElementById('manhwaTitle').textContent = '-';
  hideStatus();
  document.getElementById('scrollProgress').style.display = 'none';
  document.getElementById('zipProgress').style.display = 'none';
});

// -----------------------------------------------
// Listen messages dari content/background
// -----------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  
  if (message.type === 'BLOB_FOUND') {
    updateCount(message.count);
  }
  
  else if (message.type === 'SCROLL_PROGRESS') {
    setScrollProgress(message.progress);
  }
  
  else if (message.type === 'ZIP_PROGRESS') {
    setZipProgress(message.progress);
  }
  
});

// -----------------------------------------------
// Init: cek status saat popup dibuka
// -----------------------------------------------
async function init() {
  try {
    const response = await sendToContent({ type: 'GET_STATUS' });
    
    document.getElementById('manhwaTitle').textContent = response.title;
    updateCount(response.count);
    
    if (response.isCollecting) {
      setState('collecting');
      showStatus('Already collecting images...', 'info');
    } else if (response.count > 0) {
      setState('done');
      showStatus(`${response.count} images ready to download`, 'success');
    }
  } catch(e) {
    // Page belum load content script
    showStatus('Open a manhwa chapter page first', 'warning');
  }
}

init();
