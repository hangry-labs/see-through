const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = { file: null, previewUrl: null, jobId: null, pollTimer: null }
const previewState = {
  frame: null, running: true, hovering: false,
  pointerX: 0, pointerY: 0, currentX: 0, currentY: 0,
  layers: [], startedAt: 0,
}

function setStatus(message, tone = 'neutral') {
  $('#global-status').textContent = message
  $('#global-status').dataset.tone = tone
}

function setProgressState(status) {
  const progress = $('#job-progress')
  progress.dataset.status = status
  progress.classList.toggle('is-active', status === 'active')
}

function showToast(message) {
  const toast = $('#toast')
  toast.textContent = message
  toast.hidden = false
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { toast.hidden = true }, 6000)
}

async function responseError(response) {
  const text = await response.text()
  try { return JSON.parse(text).detail || text } catch { return text || `HTTP ${response.status}` }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function stageLabel(stage) {
  return ({
    queued: 'Queued', starting: 'Loading models',
    'layer-decomposition': 'Generating semantic layers',
    'depth-estimation': 'Estimating layer depth',
    'psd-assembly': 'Building the layered PSD',
    canceling: 'Stopping generation', canceled: 'Generation canceled',
    completed: 'Generation complete', failed: 'Generation failed',
  })[stage] || stage
}

function activateTab(tabName) {
  const button = $(`.tab-button[data-tab="${tabName}"]`)
  if (!button) return
  $$('.tab-button').forEach((item) => {
    const active = item === button
    item.classList.toggle('active', active)
    item.setAttribute('aria-selected', String(active))
  })
  $$('.tab-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== tabName })
  if (tabName === 'system') refreshRuntime()
}

$$('.tab-button').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)))
$$('[data-tab-link]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault()
  activateTab(link.dataset.tabLink)
  document.querySelector('.app-tabs').scrollIntoView({ behavior: 'smooth', block: 'start' })
}))

const dropZone = $('#drop-zone')
const fileInput = $('#file-input')
dropZone.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => selectFile(fileInput.files[0]))
;['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault()
  dropZone.classList.add('dragging')
}))
;['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault()
  dropZone.classList.remove('dragging')
}))
dropZone.addEventListener('drop', (event) => selectFile(event.dataTransfer.files[0]))

function selectFile(file) {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    showToast('Choose a supported image file.')
    return
  }
  if (file.size > 30 * 1024 * 1024) {
    showToast('The image exceeds the 30 MiB upload limit.')
    return
  }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
  state.file = file
  state.previewUrl = URL.createObjectURL(file)
  const preview = $('#image-preview')
  preview.src = state.previewUrl
  preview.onload = () => {
    $('#image-details').textContent = `${preview.naturalWidth} × ${preview.naturalHeight} · ${humanBytes(file.size)}`
  }
  $('#image-name').textContent = file.name
  dropZone.hidden = true
  $('#image-stage').hidden = false
  $('#clear-image').hidden = false
  $('#generate-button').disabled = false
  $('#results').hidden = true
  setStatus('Image ready. Adjust settings and generate.', 'success')
}

$('#clear-image').addEventListener('click', () => {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
  state.file = null
  state.previewUrl = null
  fileInput.value = ''
  dropZone.hidden = false
  $('#image-stage').hidden = true
  $('#clear-image').hidden = true
  $('#generate-button').disabled = true
  $('#results').hidden = true
  $('#job-progress').hidden = true
  setProgressState('idle')
  stopPuppetPreview()
  history.replaceState({}, '', location.pathname)
  setStatus('Add an image to begin.')
})

async function centerSquareBlob(file) {
  const bitmap = await createImageBitmap(file)
  const size = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const x = (bitmap.width - size) / 2
  const y = (bitmap.height - size) / 2
  canvas.getContext('2d').drawImage(bitmap, x, y, size, size, 0, 0, size, size)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Could not crop the selected image.')),
    'image/png',
  ))
}

$('#decompose-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.file) return
  const button = $('#generate-button')
  button.disabled = true
  $('#results').hidden = true
  $('#job-progress').hidden = false
  setProgressState('active')
  $('#cancel-job').hidden = false
  $('#cancel-job').disabled = false
  $('#cancel-job').innerHTML = '<i class="icon-square"></i> Stop generation'
  $('#job-log').textContent = ''
  $('#job-stage').textContent = 'Preparing upload'
  setStatus('Submitting generation job…')

  try {
    const upload = $('#crop-mode').value === 'center-square' ? await centerSquareBlob(state.file) : state.file
    const body = new FormData()
    body.append('file', upload, $('#crop-mode').value === 'center-square' ? 'cropped-input.png' : state.file.name)
    body.append('seed', $('#seed').value)
    body.append('resolution', $('#resolution').value)
    body.append('depth_resolution', $('#depth-resolution').value)
    body.append('inference_steps', $('#steps').value)
    body.append('group_offload', $('#group-offload').checked ? 'true' : 'false')
    const response = await fetch('/v1/layer-decompositions', { method: 'POST', body })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    setStatus('Generation is running. Keep this page open.')
    pollJob()
  } catch (error) {
    button.disabled = false
    setProgressState('failed')
    $('#job-progress').hidden = true
    setStatus(error.message, 'error')
    showToast(error.message)
  }
})

async function pollJob() {
  clearTimeout(state.pollTimer)
  try {
    const response = await fetch(`/v1/layer-decompositions/${state.jobId}`)
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    setProgressState(['completed', 'failed', 'canceled'].includes(job.status) ? job.status : 'active')
    $('#job-stage').textContent = stageLabel(job.stage)
    const log = $('#job-log')
    log.textContent = job.logs.join('\n')
    log.scrollTop = log.scrollHeight
    if (job.status === 'completed') {
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      setStatus('Layered PSD generated successfully.', 'success')
      renderResults(job)
      return
    }
    if (job.status === 'failed') {
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      setStatus(job.error || 'Generation failed.', 'error')
      showToast(job.error || 'Generation failed. Check the job log.')
      return
    }
    if (job.status === 'canceled') {
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      $('#job-stage').textContent = stageLabel(job.stage)
      setStatus('Generation canceled. The GPU is ready for another job.')
      return
    }
    state.pollTimer = setTimeout(pollJob, 1800)
  } catch (error) {
    setStatus(`Status check failed: ${error.message}`, 'error')
    state.pollTimer = setTimeout(pollJob, 3500)
  }
}

function renderResults(job) {
  const results = $('#results')
  const gallery = $('#asset-gallery')
  gallery.replaceChildren()
  $('#download-psd').href = job.download_url
  const images = job.assets.filter((asset) => asset.kind === 'png' && !asset.name.includes('_depth'))
  const priority = (asset) => asset.name === 'reconstruction.png' ? 0 : asset.name === 'src_img.png' ? 1 : 2
  images.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name))
  images.forEach((asset) => {
    const card = document.createElement('article')
    card.className = 'asset-card'
    const link = document.createElement('a')
    link.href = asset.url
    link.target = '_blank'
    const preview = document.createElement('div')
    preview.className = 'asset-preview'
    const image = document.createElement('img')
    image.loading = 'lazy'
    image.src = asset.url
    image.alt = asset.name
    preview.append(image)
    const caption = document.createElement('div')
    caption.className = 'asset-caption'
    const name = document.createElement('strong')
    name.textContent = asset.name.replace('.png', '')
    const size = document.createElement('span')
    size.textContent = humanBytes(asset.size)
    caption.append(name, size)
    link.append(preview, caption)
    card.append(link)
    gallery.append(card)
  })
  renderPuppetPreview(job).catch((error) => {
    console.warn('Layer preview unavailable:', error)
    $('#puppet-preview').hidden = true
  })
  results.hidden = false
  results.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function stopPuppetPreview() {
  if (previewState.frame) cancelAnimationFrame(previewState.frame)
  previewState.frame = null
  previewState.layers = []
  $('#puppet-rig').replaceChildren()
  $('#puppet-preview').hidden = true
}

async function renderPuppetPreview(job) {
  stopPuppetPreview()
  const metadataAsset = job.assets.find((asset) => asset.name === 'input.psd.json')
  if (!metadataAsset) return
  const response = await fetch(metadataAsset.url)
  if (!response.ok) throw new Error(await responseError(response))
  const metadata = await response.json()
  const parts = Object.entries(metadata.parts || {})
  if (!parts.length) return

  const rig = $('#puppet-rig')
  const viewport = $('#puppet-viewport')
  const [frameWidth, frameHeight] = metadata.frame_size || [1, 1]
  viewport.style.aspectRatio = `${frameWidth} / ${frameHeight}`

  for (const [name, part] of parts) {
    const asset = job.assets.find((item) => item.kind === 'png' && item.name === `${name}.png` && !item.name.endsWith('_depth.png'))
    if (!asset) continue
    const image = document.createElement('img')
    image.className = 'puppet-layer'
    image.src = asset.url
    image.alt = ''
    image.title = name
    const depth = Number.isFinite(part.depth_median) ? part.depth_median : 0.5
    const bounds = part.xyxy || [0, 0, frameWidth, frameHeight]
    image.style.zIndex = String(Math.round((1 - depth) * 1000))
    image.style.transformOrigin = `${((bounds[0] + bounds[2]) / 2 / frameWidth) * 100}% ${((bounds[1] + bounds[3]) / 2 / frameHeight) * 100}%`
    rig.append(image)
    previewState.layers.push({ element: image, depth, name })
  }
  if (!previewState.layers.length) return

  previewState.running = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  previewState.startedAt = performance.now()
  setPreviewToggleLabel()
  $('#preview-toggle').setAttribute('aria-pressed', String(previewState.running))
  $('#preview-layer-count').textContent = `${previewState.layers.length} layers`
  $('#puppet-preview').hidden = false
  previewState.frame = requestAnimationFrame(animatePuppetPreview)
}

function animatePuppetPreview(now) {
  const elapsed = (now - previewState.startedAt) / 1000
  const autoX = Math.sin(elapsed * 0.72) * 0.34
  const autoY = Math.sin(elapsed * 0.49 + 0.8) * 0.18
  const targetX = previewState.running ? (previewState.hovering ? previewState.pointerX : autoX) : 0
  const targetY = previewState.running ? (previewState.hovering ? previewState.pointerY : autoY) : 0
  previewState.currentX += (targetX - previewState.currentX) * 0.055
  previewState.currentY += (targetY - previewState.currentY) * 0.055
  const intensity = Number($('#motion-intensity').value) / 100

  $('#puppet-rig').style.transform = `rotateX(${-previewState.currentY * intensity * 1.4}deg) rotateY(${previewState.currentX * intensity * 1.8}deg)`
  previewState.layers.forEach((layer, index) => {
    const proximity = 1 - Math.max(0, Math.min(1, layer.depth))
    const parallax = 0.2 + proximity * 0.8
    const flexible = /hair|wear|tail|wing/i.test(layer.name) ? 1 : 0.3
    const sway = previewState.running ? Math.sin(elapsed * 1.15 + index * 0.47) * flexible * intensity : 0
    const x = previewState.currentX * parallax * intensity * 18 + sway * 0.65
    const y = previewState.currentY * parallax * intensity * 10 + Math.cos(elapsed * 0.9 + index) * flexible * intensity * 0.45
    const rotate = sway * proximity * 0.18
    layer.element.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,${(proximity * 18).toFixed(1)}px) rotate(${rotate.toFixed(3)}deg) scale(1.008)`
  })
  previewState.frame = requestAnimationFrame(animatePuppetPreview)
}

const puppetViewport = $('#puppet-viewport')
puppetViewport.addEventListener('pointerenter', () => { previewState.hovering = true })
puppetViewport.addEventListener('pointerleave', () => { previewState.hovering = false })
puppetViewport.addEventListener('pointermove', (event) => {
  const bounds = puppetViewport.getBoundingClientRect()
  previewState.pointerX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2
  previewState.pointerY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2
})
$('#preview-toggle').addEventListener('click', () => {
  previewState.running = !previewState.running
  setPreviewToggleLabel()
  $('#preview-toggle').setAttribute('aria-pressed', String(previewState.running))
})

function setPreviewToggleLabel() {
  $('#preview-toggle').innerHTML = previewState.running
    ? '<i class="icon-pause"></i> Pause motion'
    : '<i class="icon-play"></i> Play motion'
}

async function refreshRuntime() {
  const badge = $('#runtime-badge')
  try {
    const response = await fetch('/health/ready')
    if (!response.ok) throw new Error(await responseError(response))
    const payload = await response.json()
    const gpu = payload.gpu?.devices?.[0]
    badge.dataset.state = payload.status
    $('#runtime-title').textContent = gpu ? 'GPU runtime ready' : 'GPU unavailable'
    $('#runtime-detail').textContent = gpu ? `${gpu.name} · ${(gpu.vram_bytes / 1024 ** 3).toFixed(1)} GiB VRAM` : 'Check NVIDIA container access'
    $('#runtime-version').textContent = `UI v${payload.version || 'dev'}`
    renderModels(payload.pipeline?.models || [])
    $('#system-output').textContent = JSON.stringify(payload, null, 2)
  } catch (error) {
    badge.dataset.state = 'degraded'
    $('#runtime-title').textContent = 'Service unavailable'
    $('#runtime-detail').textContent = error.message
    $('#system-output').textContent = error.message
  }
}

async function restoreJobFromUrl() {
  const jobId = new URLSearchParams(location.search).get('job')
  if (!/^[a-f0-9]{32}$/.test(jobId || '')) return
  try {
    const response = await fetch(`/v1/layer-decompositions/${jobId}`)
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    $('#job-id').textContent = job.id.slice(0, 12)
    $('#job-stage').textContent = stageLabel(job.stage)
    $('#job-log').textContent = job.logs.join('\n')
    if (job.status === 'completed') {
      $('#job-progress').hidden = false
      setProgressState('completed')
      setStatus('Restored completed generation.', 'success')
      renderResults(job)
    } else if (job.status === 'queued' || job.status === 'running') {
      $('#job-progress').hidden = false
      setProgressState('active')
      $('#cancel-job').hidden = false
      setStatus('Restored generation in progress.')
      pollJob()
    } else {
      setProgressState(job.status)
      setStatus(job.error || `Saved job is ${job.status}.`, 'error')
    }
  } catch (error) {
    setStatus(`Could not restore job: ${error.message}`, 'error')
  }
}

$('#cancel-job').addEventListener('click', async () => {
  if (!state.jobId) return
  const button = $('#cancel-job')
  button.disabled = true
  button.textContent = 'Stopping…'
  setStatus('Stopping generation safely…')
  try {
    const response = await fetch(`/v1/layer-decompositions/${state.jobId}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await responseError(response))
    pollJob()
  } catch (error) {
    button.disabled = false
    button.innerHTML = '<i class="icon-square"></i> Stop generation'
    setStatus(`Could not stop generation: ${error.message}`, 'error')
  }
})

function renderModels(models) {
  const list = $('#model-list')
  list.replaceChildren()
  models.forEach((model) => {
    const card = document.createElement('article')
    card.className = 'model-card'
    card.dataset.optional = String(!model.used_by_generation)
    const header = document.createElement('header')
    const name = document.createElement('h3')
    name.textContent = model.name
    const state = document.createElement('span')
    state.className = 'model-state'
    state.textContent = model.state.replaceAll('-', ' ')
    const id = document.createElement('code')
    id.textContent = model.model_id
    id.title = model.model_id
    const role = document.createElement('p')
    role.textContent = model.used_by_generation ? model.role : `${model.role} Not used by Generate layered PSD.`
    header.append(name, state)
    card.append(header, id, role)
    list.append(card)
  })
}

$('#refresh-system').addEventListener('click', refreshRuntime)
refreshRuntime()
restoreJobFromUrl()
