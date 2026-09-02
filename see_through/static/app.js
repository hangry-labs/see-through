const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = {
  file: null,
  previewUrl: null,
  jobId: null,
  pollTimer: null,
  currentJob: null,
  selectedParts: new Set(),
}
const previewState = {
  frame: null, running: true, hovering: false,
  pointerX: 0, pointerY: 0, currentX: 0, currentY: 0,
  layers: [], startedAt: 0, comparing: false,
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
    'layer-stitching': 'Stitching selected layers',
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
  state.currentJob = null
  state.selectedParts.clear()
  stopPuppetPreview()
  history.replaceState({}, '', location.pathname)
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
    const seed = $('#seed').value.trim()
    if (seed) body.append('seed', seed)
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
      setStatus(
        job.kind === 'revision' ? 'Candidate revision ready for review.' : 'Layered PSD generated successfully.',
        'success',
      )
      renderResults(job)
      return
    }
    if (job.status === 'failed') {
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      setStatus(job.error || 'Generation failed.', 'error')
      showToast(job.error || 'Generation failed. Check the job log.')
      if (state.currentJob) {
        state.jobId = state.currentJob.id
        history.replaceState({}, '', `?job=${state.currentJob.id}`)
        renderRevisionHistory(state.currentJob).catch(() => {})
      }
      return
    }
    if (job.status === 'canceled') {
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      $('#job-stage').textContent = stageLabel(job.stage)
      setStatus('Generation canceled. The GPU is ready for another job.')
      if (state.currentJob) {
        state.jobId = state.currentJob.id
        history.replaceState({}, '', `?job=${state.currentJob.id}`)
        renderRevisionHistory(state.currentJob).catch(() => {})
      }
      return
    }
    state.pollTimer = setTimeout(pollJob, 1800)
  } catch (error) {
    setStatus(`Status check failed: ${error.message}`, 'error')
    state.pollTimer = setTimeout(pollJob, 3500)
  }
}

function renderResults(job) {
  $('#cancel-job').hidden = true
  state.currentJob = job
  state.jobId = job.id
  state.selectedParts.clear()
  history.replaceState({}, '', `?job=${job.id}`)
  const results = $('#results')
  const gallery = $('#asset-gallery')
  gallery.replaceChildren()
  $('#download-psd').href = job.download_url
  const candidate = job.kind === 'revision' && !job.accepted_at
  $('#result-eyebrow').textContent = candidate ? 'REVISION PREVIEW' : job.revision_number ? 'KEPT REVISION' : 'RESULT'
  $('#result-title').textContent = candidate ? 'Review candidate' : 'Generated assets'
  $('#results-copy').textContent = candidate
    ? 'Inspect the stitched preview and replacement layers. Keep this revision only when it improves the result.'
    : 'Select any imperfect or missing semantic layers below to generate a non-destructive revision.'
  $('#revision-review').hidden = !candidate
  $('#refinement-panel').hidden = candidate
  if (candidate) {
    $$('.revision-review-actions button').forEach((button) => { button.disabled = false })
    const names = job.replaced_parts.map(formatPartName)
    $('#revision-review-title').textContent = `Revision ${job.revision_number} · seed ${job.settings.seed}`
    $('#revision-review-copy').textContent = `Replaced ${formatNameList(names)}. The parent result remains unchanged.`
  }

  ;(job.parts || []).forEach((part) => {
    const card = document.createElement('article')
    card.className = 'asset-card'
    card.dataset.part = part.name
    card.dataset.visible = String(Boolean(part.visible))
    card.dataset.replaced = String(job.replaced_parts.includes(part.name))
    const label = document.createElement('label')
    label.className = 'asset-select'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.disabled = candidate
    checkbox.setAttribute('aria-label', `Select ${part.name} for regeneration`)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedParts.add(part.name)
      else state.selectedParts.delete(part.name)
      card.classList.toggle('is-selected', checkbox.checked)
      updateSelectionControls()
    })
    const preview = document.createElement('div')
    preview.className = 'asset-preview'
    if (part.url) {
      const image = document.createElement('img')
      image.loading = 'lazy'
      image.src = part.url
      image.alt = `${part.name} layer`
      preview.append(image)
    }
    const caption = document.createElement('div')
    caption.className = 'asset-caption'
    const name = document.createElement('strong')
    name.textContent = formatPartName(part.name)
    const size = document.createElement('span')
    size.textContent = part.available ? humanBytes(part.size) : 'No generated file'
    const visibility = document.createElement('span')
    visibility.className = 'part-state'
    visibility.textContent = job.replaced_parts.includes(part.name)
      ? `replacement · ${part.visible ? part.group : 'empty'}`
      : part.visible ? part.group : 'empty · retryable'
    caption.append(name, size, visibility)
    label.append(checkbox, preview, caption)
    card.append(label)
    if (part.url) {
      const link = document.createElement('a')
      link.className = 'asset-open'
      link.href = part.url
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.title = `Open ${part.name} layer`
      link.innerHTML = '<i class="icon-external-link"></i>'
      card.append(link)
    }
    gallery.append(card)
  })
  updateSelectionControls()
  renderPuppetPreview(job).catch((error) => {
    console.warn('Layer preview unavailable:', error)
    $('#puppet-preview').hidden = true
  })
  renderRevisionHistory(job).catch((error) => console.warn('Revision history unavailable:', error))
  results.hidden = false
  results.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function formatPartName(name) {
  return name.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase())
}

function formatNameList(names) {
  if (names.length < 2) return names[0] || 'selected layers'
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function updateSelectionControls() {
  const names = [...state.selectedParts].map(formatPartName)
  const count = names.length
  $('#selected-part-count').textContent = count ? `${count} layer${count === 1 ? '' : 's'} selected` : 'No layers selected'
  $('#selected-part-names').textContent = count ? formatNameList(names) : 'Choose one or more cards below.'
  $('#clear-part-selection').disabled = !count
  $('#regenerate-selected').disabled = !count
}

async function renderRevisionHistory(job) {
  const response = await fetch(`/v1/layer-decompositions/${job.id}/revisions`)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json()
  const list = $('#revision-list')
  list.replaceChildren()
  payload.items.forEach((item) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'revision-item'
    button.classList.toggle('is-current', item.id === job.id)
    button.disabled = item.status !== 'completed'
    const number = document.createElement('span')
    number.className = 'revision-number'
    number.textContent = item.revision_number ? `R${item.revision_number}` : 'Base'
    const copy = document.createElement('span')
    copy.className = 'revision-item-copy'
    const title = document.createElement('strong')
    title.textContent = item.replaced_parts.length
      ? formatNameList(item.replaced_parts.map(formatPartName))
      : 'Initial decomposition'
    const detail = document.createElement('span')
    detail.textContent = `Seed ${item.settings.seed ?? 'unknown'} · ${stageLabel(item.stage)}`
    copy.append(title, detail)
    const badge = document.createElement('span')
    badge.className = 'revision-badge'
    badge.classList.toggle('is-kept', Boolean(item.accepted_at))
    badge.textContent = item.accepted_at ? 'Kept' : item.status === 'completed' ? 'Candidate' : item.status
    button.append(number, copy, badge)
    if (item.status === 'completed') button.addEventListener('click', () => showJob(item.id))
    list.append(button)
  })
  $('#revision-history').hidden = payload.items.length < 2
}

async function startRevision(parentJobId, parts) {
  if (!parentJobId || !parts.length) return
  clearTimeout(state.pollTimer)
  $('#job-progress').hidden = false
  setProgressState('active')
  $('#job-stage').textContent = 'Preparing revision'
  $('#job-log').textContent = ''
  $('#cancel-job').hidden = false
  $('#cancel-job').disabled = false
  $('#cancel-job').innerHTML = '<i class="icon-square"></i> Stop generation'
  $('#regenerate-selected').disabled = true
  $$('.revision-review-actions button').forEach((button) => { button.disabled = true })
  setStatus(`Regenerating ${parts.length} selected layer${parts.length === 1 ? '' : 's'}…`)
  $('#job-progress').scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const body = new FormData()
    parts.forEach((part) => body.append('parts', part))
    const seed = $('#revision-seed').value.trim()
    if (seed) body.append('seed', seed)
    const response = await fetch(`/v1/layer-decompositions/${parentJobId}/revisions`, { method: 'POST', body })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    pollJob()
  } catch (error) {
    setProgressState('failed')
    $('#cancel-job').hidden = true
    updateSelectionControls()
    $$('.revision-review-actions button').forEach((button) => { button.disabled = false })
    setStatus(error.message, 'error')
    showToast(error.message)
  }
}

async function showJob(jobId) {
  clearTimeout(state.pollTimer)
  try {
    const response = await fetch(`/v1/layer-decompositions/${jobId}`)
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    $('#job-id').textContent = job.id.slice(0, 12)
    $('#job-stage').textContent = stageLabel(job.stage)
    $('#job-log').textContent = job.logs.join('\n')
    $('#job-progress').hidden = false
    if (job.status === 'completed') {
      setProgressState('completed')
      $('#cancel-job').hidden = true
      renderResults(job)
      setStatus(job.accepted_at ? 'Viewing a kept result.' : 'Review this candidate revision.', 'success')
    } else if (job.status === 'queued' || job.status === 'running') {
      setProgressState('active')
      $('#cancel-job').hidden = false
      pollJob()
    } else {
      if (job.parent_job_id) {
        await showJob(job.parent_job_id)
        setProgressState(job.status)
        $('#job-stage').textContent = stageLabel(job.stage)
        setStatus(job.error || `Revision attempt ${job.status}. The parent result is still available.`, job.status === 'failed' ? 'error' : 'neutral')
        return
      }
      setProgressState(job.status)
      $('#cancel-job').hidden = true
      setStatus(job.error || `Saved job is ${job.status}.`, 'error')
      await renderRevisionHistory(job)
    }
  } catch (error) {
    setStatus(`Could not load job: ${error.message}`, 'error')
  }
}

$('#clear-part-selection').addEventListener('click', () => {
  state.selectedParts.clear()
  $$('#asset-gallery input[type="checkbox"]').forEach((input) => { input.checked = false })
  $$('.asset-card').forEach((card) => card.classList.remove('is-selected'))
  updateSelectionControls()
})

$('#regenerate-selected').addEventListener('click', () => {
  if (!state.currentJob?.accepted_at) return
  startRevision(state.currentJob.id, [...state.selectedParts])
})

$('#keep-revision').addEventListener('click', async () => {
  if (!state.currentJob || state.currentJob.accepted_at) return
  const button = $('#keep-revision')
  button.disabled = true
  try {
    const response = await fetch(`/v1/layer-decompositions/${state.currentJob.id}/accept`, { method: 'POST' })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    renderResults(job)
    setStatus('Revision kept. You can refine additional layers or download the new PSD.', 'success')
  } catch (error) {
    setStatus(`Could not keep revision: ${error.message}`, 'error')
    showToast(error.message)
  } finally {
    button.disabled = false
  }
})

$('#retry-revision').addEventListener('click', () => {
  const job = state.currentJob
  if (!job?.parent_job_id) return
  $('#revision-seed').value = ''
  startRevision(job.parent_job_id, job.replaced_parts)
})

$('#return-to-parent').addEventListener('click', () => {
  if (state.currentJob?.parent_job_id) showJob(state.currentJob.parent_job_id)
})

function stopPuppetPreview() {
  if (previewState.frame) cancelAnimationFrame(previewState.frame)
  previewState.frame = null
  previewState.layers = []
  setPreviewComparison(false)
  $('#puppet-rig').replaceChildren()
  const original = $('#puppet-original')
  original.onload = null
  original.onerror = null
  original.removeAttribute('src')
  original.hidden = true
  $('#preview-compare').hidden = true
  $('#puppet-preview').hidden = true
}

function previewDepths(parts) {
  const depths = new Map(Object.entries(parts).map(([name, part]) => [
    name,
    Number.isFinite(part.depth_median) ? part.depth_median : 0.5,
  ]))
  const placeInFront = (foreground, background) => {
    if (!depths.has(foreground) || !depths.has(background)) return
    depths.set(foreground, Math.min(depths.get(foreground), depths.get(background) - 0.002))
  }

  // Depth estimation is visual rather than semantic. Keep connected body parts
  // together during parallax even when their median depth values are nearly tied.
  placeInFront('neck', 'topwear')
  placeInFront('neckwear', 'neck')
  return depths
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
  const eyeStack = ['eyewhite', 'irides', 'eyelash', 'eyebrow', 'eyewear']
  const eyeDepths = eyeStack
    .map((name) => metadata.parts[name]?.depth_median)
    .filter((depth) => Number.isFinite(depth))
  const eyeAnchor = eyeDepths.length ? Math.min(...eyeDepths) : null
  const semanticDepths = previewDepths(metadata.parts)

  const rig = $('#puppet-rig')
  const viewport = $('#puppet-viewport')
  const [frameWidth, frameHeight] = metadata.frame_size || [1, 1]
  viewport.style.aspectRatio = `${frameWidth} / ${frameHeight}`

  const originalAsset = job.assets.find((asset) => asset.kind === 'png' && asset.name === 'src_img.png')
  if (originalAsset) {
    const original = $('#puppet-original')
    original.onload = () => { $('#preview-compare').hidden = false }
    original.onerror = () => {
      original.hidden = true
      $('#preview-compare').hidden = true
    }
    original.src = originalAsset.url
    original.hidden = false
  }

  for (const [name, part] of parts) {
    const asset = job.assets.find((item) => item.kind === 'png' && item.name === `${name}.png` && !item.name.endsWith('_depth.png'))
    if (!asset) continue
    const image = document.createElement('img')
    image.className = 'puppet-layer'
    image.src = asset.url
    image.alt = ''
    image.title = name
    const rawDepth = semanticDepths.get(name)
    const eyeIndex = eyeStack.indexOf(name)
    const depth = eyeIndex >= 0 && eyeAnchor !== null
      ? eyeAnchor + (eyeStack.length - 1 - eyeIndex) * 0.002
      : rawDepth
    const bounds = part.xyxy || [0, 0, frameWidth, frameHeight]
    image.style.zIndex = String(Math.round((1 - depth) * 10000))
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

const previewCompare = $('#preview-compare')

function setPreviewComparison(comparing) {
  previewState.comparing = comparing
  $('#puppet-viewport').dataset.comparing = String(comparing)
  previewCompare.setAttribute('aria-pressed', String(comparing))
  $('span', previewCompare).textContent = comparing ? 'Showing original' : 'Hold for original'
}

previewCompare.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || previewCompare.hidden) return
  previewCompare.setPointerCapture(event.pointerId)
  setPreviewComparison(true)
})
previewCompare.addEventListener('pointerup', () => setPreviewComparison(false))
previewCompare.addEventListener('pointercancel', () => setPreviewComparison(false))
previewCompare.addEventListener('lostpointercapture', () => setPreviewComparison(false))
previewCompare.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) setPreviewComparison(true)
})
previewCompare.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') setPreviewComparison(false)
})
previewCompare.addEventListener('blur', () => setPreviewComparison(false))
window.addEventListener('blur', () => setPreviewComparison(false))

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
  await showJob(jobId)
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
