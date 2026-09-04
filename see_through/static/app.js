const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = {
  file: null,
  previewUrl: null,
  jobId: null,
  pollTimer: null,
  currentJob: null,
  selectedParts: new Set(),
  processingKind: null,
  processingParts: new Set(),
  layerOrder: [],
  automaticLayerOrder: [],
  initialLayerOrder: [],
  layerMetadata: null,
  draggedPart: null,
}
const previewState = {
  frame: null, running: true, hovering: false,
  pointerX: 0, pointerY: 0, currentX: 0, currentY: 0,
  layers: [], startedAt: 0, comparing: false,
}
const editorState = {
  job: null, part: null, base: null, original: null, layers: [], depths: new Map(),
  order: [],
  maskCanvas: document.createElement('canvas'), editedCanvas: document.createElement('canvas'),
  sourceCanvas: document.createElement('canvas'), undo: [], redo: [], painting: false,
  lastPoint: null, distanceToNextDab: 0, renderPending: false,
  cursorX: 0, cursorY: 0, cursorVisible: false,
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
    'layer-editing': 'Applying detail edits',
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
      setProcessingState()
      $('#generate-button').disabled = false
      $('#cancel-job').hidden = true
      setStatus(
        job.kind === 'edit' ? 'Detail edit ready for review.'
          : job.kind === 'depth' ? 'Depth revision ready for review.'
          : job.kind === 'order' ? 'Layer order revision ready for review.'
          : job.kind === 'revision' ? 'Candidate revision ready for review.'
            : 'Layered PSD generated successfully.',
        'success',
      )
      await renderResults(job)
      return
    }
    if (job.status === 'failed') {
      setProcessingState()
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
      setProcessingState()
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
    setProcessingState(job.kind, job.replaced_parts, stageLabel(job.stage))
    state.pollTimer = setTimeout(pollJob, 1800)
  } catch (error) {
    setStatus(`Status check failed: ${error.message}`, 'error')
    state.pollTimer = setTimeout(pollJob, 3500)
  }
}

async function renderResults(job) {
  setProcessingState()
  $('#cancel-job').hidden = true
  state.currentJob = job
  state.jobId = job.id
  state.selectedParts.clear()
  history.replaceState({}, '', `?job=${job.id}`)
  const results = $('#results')
  const gallery = $('#asset-gallery')
  gallery.replaceChildren()
  let metadata = { parts: {} }
  try {
    metadata = await loadLayerMetadata(job)
  } catch (error) {
    console.warn('Layer metadata unavailable:', error)
  }
  state.layerMetadata = metadata
  state.automaticLayerOrder = automaticLayerOrder(metadata)
  const explicitOrder = Array.isArray(metadata.layer_order)
    ? metadata.layer_order.filter((name) => state.automaticLayerOrder.includes(name))
    : []
  state.layerOrder = explicitOrder.length === state.automaticLayerOrder.length
    ? [...explicitOrder]
    : [...state.automaticLayerOrder]
  state.initialLayerOrder = [...state.layerOrder]
  state.draggedPart = null
  $('#download-psd').href = job.download_url
  const candidate = job.kind !== 'generation' && !job.accepted_at
  $('#result-eyebrow').textContent = candidate ? 'REVISION PREVIEW' : job.revision_number ? 'KEPT REVISION' : 'RESULT'
  $('#result-title').textContent = candidate ? 'Review candidate' : 'Generated assets'
  $('#results-copy').textContent = candidate
    ? job.kind === 'depth'
      ? 'Inspect the new ordering and layer motion. The artwork is unchanged until you keep this depth revision.'
      : job.kind === 'order'
        ? 'Inspect the manual stack in the grid and 2.5D preview. Keep it only when the overlap is correct.'
      : 'Inspect the stitched preview and replacement layers. Keep this revision only when it improves the result.'
    : 'Select any imperfect or missing semantic layers below to generate a non-destructive revision.'
  $('#revision-review').hidden = !candidate
  $('#refinement-panel').hidden = candidate
  $('#retry-revision').hidden = job.kind === 'edit' || job.kind === 'order'
  $('#layer-order-panel').hidden = candidate || !state.layerOrder.length
  if (candidate) {
    $$('.revision-review-actions button').forEach((button) => { button.disabled = false })
    const names = job.replaced_parts.map(formatPartName)
    $('#revision-review-title').textContent = job.kind === 'edit'
      ? `Revision ${job.revision_number} · detail edit`
      : job.kind === 'depth'
        ? `Revision ${job.revision_number} · depth seed ${job.settings.seed}`
        : job.kind === 'order'
          ? `Revision ${job.revision_number} · manual layer order`
        : `Revision ${job.revision_number} · seed ${job.settings.seed}`
    $('#revision-review-copy').textContent = job.kind === 'edit'
      ? job.settings.depth_recalculated
        ? `Restored original detail in ${formatNameList(names)} and recalculated depth because new pixels became visible.`
        : `Restored original detail in ${formatNameList(names)} while preserving its existing depth.`
      : job.kind === 'depth'
        ? `Recalculated all layer depths at ${job.settings.depth_resolution} px. The parent result remains unchanged.`
        : job.kind === 'order'
          ? 'Rebuilt the PSD with the selected front-to-back stack. The parent result remains unchanged.'
        : `Replaced ${formatNameList(names)}. The parent result remains unchanged.`
  }

  const depthResolution = String(job.settings.depth_resolution || '')
  if ($(`#depth-revision-resolution option[value="${depthResolution}"]`)) {
    $('#depth-revision-resolution').value = depthResolution
  }

  const orderIndex = new Map(state.layerOrder.map((name, index) => [name, index]))
  const orderedParts = [...(job.parts || [])].sort((left, right) => {
    const leftIndex = orderIndex.get(left.name)
    const rightIndex = orderIndex.get(right.name)
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
    if (leftIndex !== undefined) return -1
    if (rightIndex !== undefined) return 1
    return 0
  })

  orderedParts.forEach((part) => {
    const card = document.createElement('article')
    card.className = 'asset-card'
    card.dataset.part = part.name
    card.dataset.visible = String(Boolean(part.visible))
    card.dataset.replaced = String(job.replaced_parts.includes(part.name))
    card.dataset.edited = String(Boolean(part.edited))
    const reorderable = Boolean(job.accepted_at && orderIndex.has(part.name))
    card.dataset.reorderable = String(reorderable)
    card.draggable = reorderable
    if (orderIndex.has(part.name)) {
      const orderBadge = document.createElement('span')
      orderBadge.className = 'asset-order-badge'
      card.append(orderBadge)
    }
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
    visibility.textContent = part.edited
      ? `detail edited · ${part.visible ? part.group : 'empty'}`
      : job.replaced_parts.includes(part.name)
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
    if (part.url && job.accepted_at) {
      const actions = document.createElement('div')
      actions.className = 'asset-card-actions'
      if (reorderable) {
        const forward = document.createElement('button')
        forward.type = 'button'
        forward.className = 'text-button asset-order-step'
        forward.dataset.direction = 'forward'
        forward.title = `Move ${part.name} toward the front`
        forward.setAttribute('aria-label', forward.title)
        forward.innerHTML = '<i class="icon-arrow-left"></i>'
        forward.addEventListener('click', () => moveLayerOrder(part.name, -1))
        actions.append(forward)
      }
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'text-button asset-edit'
      edit.innerHTML = `<i class="icon-paintbrush"></i> ${part.edited ? 'Continue editing' : 'Edit details'}`
      edit.addEventListener('click', () => openLayerEditor(job, part))
      actions.append(edit)
      if (reorderable) {
        const backward = document.createElement('button')
        backward.type = 'button'
        backward.className = 'text-button asset-order-step'
        backward.dataset.direction = 'backward'
        backward.title = `Move ${part.name} toward the back`
        backward.setAttribute('aria-label', backward.title)
        backward.innerHTML = '<i class="icon-arrow-right"></i>'
        backward.addEventListener('click', () => moveLayerOrder(part.name, 1))
        actions.append(backward)
      }
      card.append(actions)
    }
    if (reorderable) bindLayerDragEvents(card)
    gallery.append(card)
  })
  renderLayerOrder()
  updateSelectionControls()
  renderPuppetPreview(job, metadata).catch((error) => {
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

async function loadLayerMetadata(job) {
  const asset = job.assets.find((item) => item.name === 'input.psd.json')
  if (!asset) return { parts: {} }
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(await responseError(response))
  return response.json()
}

function automaticLayerOrder(metadata) {
  const parts = metadata.parts || {}
  const semanticDepths = previewDepths(parts)
  const eyeStack = ['eyewhite', 'irides', 'eyelash', 'eyebrow', 'eyewear']
  const eyeDepths = eyeStack
    .map((name) => parts[name]?.depth_median)
    .filter((depth) => Number.isFinite(depth))
  const eyeAnchor = eyeDepths.length ? Math.min(...eyeDepths) : null
  const canonicalIndex = new Map((state.currentJob?.parts || []).map((part, index) => [part.name, index]))
  return Object.keys(parts).sort((left, right) => {
    const depthFor = (name) => {
      const eyeIndex = eyeStack.indexOf(name)
      if (eyeIndex >= 0 && eyeAnchor !== null) {
        return eyeAnchor + (eyeStack.length - 1 - eyeIndex) * 0.002
      }
      return semanticDepths.get(name) ?? 0.5
    }
    return depthFor(left) - depthFor(right)
      || (canonicalIndex.get(left) ?? 999) - (canonicalIndex.get(right) ?? 999)
  })
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

function applyPreviewLayerOrder() {
  const orderIndex = new Map(state.layerOrder.map((name, index) => [name, index]))
  const count = Math.max(1, state.layerOrder.length)
  previewState.layers.forEach((layer) => {
    const index = orderIndex.get(layer.name)
    if (index === undefined) return
    layer.stackProximity = count === 1 ? 1 : 1 - index / (count - 1)
    layer.element.style.zIndex = String(10000 + count - index)
  })
}

function renderLayerOrder() {
  const gallery = $('#asset-gallery')
  const cards = $$('.asset-card', gallery)
  const cardsByPart = new Map(cards.map((card) => [card.dataset.part, card]))
  state.layerOrder.forEach((name) => {
    const card = cardsByPart.get(name)
    if (card) gallery.append(card)
  })
  cards.filter((card) => !state.layerOrder.includes(card.dataset.part)).forEach((card) => gallery.append(card))

  const count = state.layerOrder.length
  state.layerOrder.forEach((name, index) => {
    const card = cardsByPart.get(name)
    if (!card) return
    const badge = $('.asset-order-badge', card)
    if (badge) {
      badge.textContent = index === 0 ? '1 · FRONT' : index === count - 1 ? `${index + 1} · BACK` : String(index + 1)
      badge.dataset.edge = index === 0 ? 'front' : index === count - 1 ? 'back' : ''
    }
    const forward = $('[data-direction="forward"]', card)
    const backward = $('[data-direction="backward"]', card)
    if (forward) forward.disabled = state.processingKind !== null || index === 0
    if (backward) backward.disabled = state.processingKind !== null || index === count - 1
  })

  const dirty = !sameOrder(state.layerOrder, state.initialLayerOrder)
  const automatic = sameOrder(state.layerOrder, state.automaticLayerOrder)
  $('#save-layer-order').disabled = state.processingKind !== null || !dirty
  $('#reset-layer-order').disabled = state.processingKind !== null || automatic
  $('#layer-order-status').textContent = dirty
    ? automatic
      ? 'Automatic order restored locally. Save it to create a reviewable revision.'
      : 'Unsaved manual order. The 2.5D preview is showing this stack live.'
    : Array.isArray(state.layerMetadata?.layer_order)
      ? 'Saved manual order. Drag a visible card or use its arrow buttons to make another revision.'
      : 'Automatic Marigold order. Drag a visible card to override it.'
  applyPreviewLayerOrder()
}

function moveLayerOrder(part, direction) {
  if (state.processingKind !== null) return
  const index = state.layerOrder.indexOf(part)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= state.layerOrder.length) return
  ;[state.layerOrder[index], state.layerOrder[destination]] = [state.layerOrder[destination], state.layerOrder[index]]
  renderLayerOrder()
}

function bindLayerDragEvents(card) {
  card.addEventListener('dragstart', (event) => {
    if (state.processingKind !== null) {
      event.preventDefault()
      return
    }
    state.draggedPart = card.dataset.part
    card.classList.add('is-dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', card.dataset.part)
  })
  card.addEventListener('dragover', (event) => {
    if (!state.draggedPart || state.draggedPart === card.dataset.part) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    $$('.asset-card.is-drop-target').forEach((item) => item.classList.remove('is-drop-target'))
    card.classList.add('is-drop-target')
  })
  card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'))
  card.addEventListener('drop', (event) => {
    event.preventDefault()
    const dragged = state.draggedPart
    const target = card.dataset.part
    if (!dragged || dragged === target) return
    const nextOrder = state.layerOrder.filter((name) => name !== dragged)
    const targetIndex = nextOrder.indexOf(target)
    const bounds = card.getBoundingClientRect()
    const horizontal = Math.abs(event.clientY - (bounds.top + bounds.height / 2)) < bounds.height / 3
    const placeAfter = horizontal
      ? event.clientX > bounds.left + bounds.width / 2
      : event.clientY > bounds.top + bounds.height / 2
    nextOrder.splice(targetIndex + (placeAfter ? 1 : 0), 0, dragged)
    state.layerOrder = nextOrder
    renderLayerOrder()
  })
  card.addEventListener('dragend', () => {
    state.draggedPart = null
    $$('.asset-card.is-dragging,.asset-card.is-drop-target').forEach((item) => {
      item.classList.remove('is-dragging', 'is-drop-target')
    })
  })
}

function setProcessingState(kind = null, parts = [], label = 'Processing') {
  state.processingKind = kind
  state.processingParts = new Set(parts || [])
  const busy = Boolean(kind)
  $$('.asset-card').forEach((card) => {
    const affected = busy && (kind === 'depth' || kind === 'order' || kind === 'generation' || state.processingParts.has(card.dataset.part))
    card.classList.toggle('is-processing', affected)
    card.toggleAttribute('aria-busy', affected)
    if (affected) card.dataset.processingLabel = label
    else delete card.dataset.processingLabel
    $$('button,input', card).forEach((control) => {
      if (affected) {
        if (control.dataset.processingWasDisabled === undefined) {
          control.dataset.processingWasDisabled = String(control.disabled)
        }
        control.disabled = true
      } else if (control.dataset.processingWasDisabled !== undefined) {
        control.disabled = control.dataset.processingWasDisabled === 'true'
        delete control.dataset.processingWasDisabled
      }
    })
  })
  for (const selector of ['#revision-seed', '#depth-revision-seed', '#depth-revision-resolution']) {
    $(selector).disabled = busy
  }
  updateSelectionControls()
  if (state.layerOrder.length) renderLayerOrder()
}

function updateSelectionControls() {
  const names = [...state.selectedParts].map(formatPartName)
  const count = names.length
  $('#selected-part-count').textContent = count ? `${count} layer${count === 1 ? '' : 's'} selected` : 'No layers selected'
  $('#selected-part-names').textContent = count ? formatNameList(names) : 'Choose one or more cards below.'
  $('#clear-part-selection').disabled = state.processingKind !== null || !count
  $('#regenerate-selected').disabled = state.processingKind !== null || !count
  $('#recalculate-depth').disabled = state.processingKind !== null || !state.currentJob?.accepted_at
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
    title.textContent = item.kind === 'depth'
      ? 'Depth ordering'
      : item.kind === 'order'
        ? 'Manual layer order'
      : item.replaced_parts.length
        ? formatNameList(item.replaced_parts.map(formatPartName))
        : 'Initial decomposition'
    const detail = document.createElement('span')
    detail.textContent = item.kind === 'edit'
      ? `Manual detail edit${item.settings.depth_recalculated ? ' + depth' : ''} · ${stageLabel(item.stage)}`
      : item.kind === 'depth'
        ? `${item.settings.depth_resolution} px · seed ${item.settings.seed ?? 'unknown'} · ${stageLabel(item.stage)}`
        : item.kind === 'order'
          ? `Front-to-back stack · ${stageLabel(item.stage)}`
        : `Seed ${item.settings.seed ?? 'unknown'} · ${stageLabel(item.stage)}`
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
  setProcessingState('revision', parts, 'Preparing regeneration')
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
    setProcessingState(job.kind, job.replaced_parts, stageLabel(job.stage))
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    pollJob()
  } catch (error) {
    setProcessingState()
    setProgressState('failed')
    $('#cancel-job').hidden = true
    updateSelectionControls()
    $$('.revision-review-actions button').forEach((button) => { button.disabled = false })
    setStatus(error.message, 'error')
    showToast(error.message)
  }
}

async function startDepthRevision(parentJobId) {
  if (!parentJobId) return
  clearTimeout(state.pollTimer)
  $('#job-progress').hidden = false
  setProgressState('active')
  $('#job-stage').textContent = 'Preparing depth revision'
  $('#job-log').textContent = ''
  $('#cancel-job').hidden = false
  $('#cancel-job').disabled = false
  $('#cancel-job').innerHTML = '<i class="icon-square"></i> Stop depth'
  setProcessingState('depth', [], 'Preparing depth')
  $$('.revision-review-actions button').forEach((button) => { button.disabled = true })
  setStatus('Recalculating depth for every layer…')
  $('#job-progress').scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const body = new FormData()
    const seed = $('#depth-revision-seed').value.trim()
    if (seed) body.append('seed', seed)
    body.append('depth_resolution', $('#depth-revision-resolution').value)
    const response = await fetch(`/v1/layer-decompositions/${parentJobId}/depth-revisions`, { method: 'POST', body })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    setProcessingState(job.kind, job.replaced_parts, stageLabel(job.stage))
    pollJob()
  } catch (error) {
    setProcessingState()
    setProgressState('failed')
    $('#cancel-job').hidden = true
    $$('.revision-review-actions button').forEach((button) => { button.disabled = false })
    setStatus(error.message, 'error')
    showToast(error.message)
  }
}

async function startOrderRevision(parentJobId) {
  if (!parentJobId || !state.layerOrder.length) return
  clearTimeout(state.pollTimer)
  $('#job-progress').hidden = false
  setProgressState('active')
  $('#job-stage').textContent = 'Preparing layer order'
  $('#job-log').textContent = ''
  $('#cancel-job').hidden = false
  $('#cancel-job').disabled = false
  $('#cancel-job').innerHTML = '<i class="icon-square"></i> Stop ordering'
  setProcessingState('order', [], 'Building layer stack')
  $$('.revision-review-actions button').forEach((button) => { button.disabled = true })
  setStatus('Building a PSD with the selected front-to-back order…')
  $('#job-progress').scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const body = new FormData()
    state.layerOrder.forEach((part) => body.append('order', part))
    const response = await fetch(`/v1/layer-decompositions/${parentJobId}/order-revisions`, { method: 'POST', body })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    setProcessingState(job.kind, job.replaced_parts, stageLabel(job.stage))
    pollJob()
  } catch (error) {
    setProcessingState()
    setProgressState('failed')
    $('#cancel-job').hidden = true
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
      await renderResults(job)
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

$('#recalculate-depth').addEventListener('click', () => {
  if (!state.currentJob?.accepted_at) return
  startDepthRevision(state.currentJob.id)
})

$('#reset-layer-order').addEventListener('click', () => {
  state.layerOrder = [...state.automaticLayerOrder]
  renderLayerOrder()
})

$('#save-layer-order').addEventListener('click', () => {
  if (!state.currentJob?.accepted_at || sameOrder(state.layerOrder, state.initialLayerOrder)) return
  startOrderRevision(state.currentJob.id)
})

$('#keep-revision').addEventListener('click', async () => {
  if (!state.currentJob || state.currentJob.accepted_at) return
  const button = $('#keep-revision')
  button.disabled = true
  try {
    const response = await fetch(`/v1/layer-decompositions/${state.currentJob.id}/accept`, { method: 'POST' })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    await renderResults(job)
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
  if (job.kind === 'depth') {
    $('#depth-revision-seed').value = ''
    startDepthRevision(job.parent_job_id)
  } else {
    $('#revision-seed').value = ''
    startRevision(job.parent_job_id, job.replaced_parts)
  }
})

$('#return-to-parent').addEventListener('click', () => {
  if (state.currentJob?.parent_job_id) showJob(state.currentJob.parent_job_id)
})

function loadEditorImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load editor asset: ${url}`))
    image.src = url
  })
}

function editorAsset(job, filename, exactPath = null) {
  return job.assets.find((asset) => exactPath ? asset.path === exactPath : asset.name === filename)
}

async function openLayerEditor(job, part) {
  const dialog = $('#layer-editor')
  if (!dialog.open) dialog.showModal()
  $('#editor-title').textContent = `Edit ${formatPartName(part.name)}`
  $('#editor-status').textContent = 'Loading full-resolution layer assets…'
  $('#save-editor').disabled = true
  editorState.job = job
  editorState.part = part
  editorState.undo = []
  editorState.redo = []
  updateEditorHistoryButtons()

  try {
    const originalAsset = editorAsset(job, 'src_img.png', 'output/input/src_img.png')
      || editorAsset(job, 'src_img.png')
    if (!originalAsset || !part.base_url) throw new Error('This result does not contain editable source assets.')
    const metadataAsset = editorAsset(job, 'input.psd.json')
    const metadataPromise = metadataAsset
      ? fetch(metadataAsset.url).then(async (response) => response.ok ? response.json() : {})
      : Promise.resolve({})
    const [base, original, metadata, maskImage, layerResults] = await Promise.all([
      loadEditorImage(part.base_url),
      loadEditorImage(originalAsset.url),
      metadataPromise,
      part.edit_mask_url ? loadEditorImage(part.edit_mask_url) : Promise.resolve(null),
      Promise.all((job.parts || []).filter((item) => item.url).map(async (item) => ({
        name: item.name,
        image: await loadEditorImage(item.url),
      }))),
    ])
    if (editorState.job?.id !== job.id || editorState.part?.name !== part.name) return
    if (base.naturalWidth !== original.naturalWidth || base.naturalHeight !== original.naturalHeight) {
      throw new Error('The generated layer and original image are not aligned.')
    }
    editorState.base = base
    editorState.original = original
    editorState.layers = layerResults
    editorState.depths = new Map(Object.entries(metadata.parts || {}).map(([name, value]) => [
      name,
      Number.isFinite(value.depth_median) ? value.depth_median : 0.5,
    ]))
    editorState.order = Array.isArray(metadata.layer_order)
      ? [...metadata.layer_order]
      : [...state.layerOrder]

    const width = base.naturalWidth
    const height = base.naturalHeight
    for (const canvas of [$('#editor-canvas'), editorState.maskCanvas, editorState.editedCanvas, editorState.sourceCanvas]) {
      canvas.width = width
      canvas.height = height
    }
    const maskContext = editorState.maskCanvas.getContext('2d', { willReadFrequently: true })
    maskContext.globalCompositeOperation = 'source-over'
    maskContext.globalAlpha = 1
    maskContext.clearRect(0, 0, width, height)
    if (maskImage) {
      maskContext.drawImage(maskImage, 0, 0, width, height)
      const pixels = maskContext.getImageData(0, 0, width, height)
      for (let index = 0; index < pixels.data.length; index += 4) {
        const coverage = Math.round(pixels.data[index] * pixels.data[index + 3] / 255)
        pixels.data[index] = 255
        pixels.data[index + 1] = 255
        pixels.data[index + 2] = 255
        pixels.data[index + 3] = coverage
      }
      maskContext.putImageData(pixels, 0, 0)
    }
    $('#editor-dimensions').textContent = `${width} × ${height} px`
    $('#editor-status').textContent = 'Paint original details into this layer. Saving creates a reviewable revision.'
    $('#save-editor').disabled = false
    requestEditorRender()
    requestAnimationFrame(fitEditorCanvas)
  } catch (error) {
    $('#editor-status').textContent = error.message
    showToast(error.message)
  }
}

function closeLayerEditor() {
  const dialog = $('#layer-editor')
  if (dialog.open) dialog.close()
  editorState.job = null
  editorState.part = null
  editorState.base = null
  editorState.original = null
  editorState.layers = []
  editorState.order = []
  editorState.undo = []
  editorState.redo = []
  editorState.cursorVisible = false
  $('#editor-brush-cursor').hidden = true
}

function renderEditedLayer() {
  if (!editorState.base || !editorState.original) return
  const { width, height } = editorState.editedCanvas
  const edited = editorState.editedCanvas.getContext('2d')
  edited.clearRect(0, 0, width, height)
  edited.globalCompositeOperation = 'source-over'
  edited.globalAlpha = 1
  edited.drawImage(editorState.base, 0, 0, width, height)
  edited.globalCompositeOperation = 'destination-out'
  edited.drawImage(editorState.maskCanvas, 0, 0)

  const source = editorState.sourceCanvas.getContext('2d')
  source.clearRect(0, 0, width, height)
  source.globalCompositeOperation = 'source-over'
  source.drawImage(editorState.original, 0, 0, width, height)
  source.globalCompositeOperation = 'destination-in'
  source.drawImage(editorState.maskCanvas, 0, 0)
  edited.globalCompositeOperation = 'source-over'
  edited.drawImage(editorState.sourceCanvas, 0, 0)
}

function requestEditorRender() {
  if (editorState.renderPending) return
  editorState.renderPending = true
  requestAnimationFrame(() => {
    editorState.renderPending = false
    renderLayerEditor()
  })
}

function renderLayerEditor() {
  if (!editorState.base || !editorState.part) return
  renderEditedLayer()
  const canvas = $('#editor-canvas')
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.globalAlpha = Number($('#original-opacity').value) / 100
  context.drawImage(editorState.original, 0, 0, canvas.width, canvas.height)

  const otherOpacity = Number($('#other-opacity').value) / 100
  const assetOpacity = Number($('#asset-opacity').value) / 100
  const orderIndex = new Map(editorState.order.map((name, index) => [name, index]))
  const layers = [...editorState.layers].sort((left, right) => {
    if (orderIndex.has(left.name) && orderIndex.has(right.name)) {
      return orderIndex.get(right.name) - orderIndex.get(left.name)
    }
    return (editorState.depths.get(right.name) ?? 0.5) - (editorState.depths.get(left.name) ?? 0.5)
  })
  if (otherOpacity === 0) {
    context.globalAlpha = assetOpacity
    context.drawImage(editorState.editedCanvas, 0, 0)
  } else {
    let drewSelected = false
    layers.forEach((layer) => {
      if (layer.name === editorState.part.name) drewSelected = true
      context.globalAlpha = layer.name === editorState.part.name ? assetOpacity : otherOpacity
      context.drawImage(
        layer.name === editorState.part.name ? editorState.editedCanvas : layer.image,
        0,
        0,
        canvas.width,
        canvas.height,
      )
    })
    if (!drewSelected) {
      context.globalAlpha = assetOpacity
      context.drawImage(editorState.editedCanvas, 0, 0)
    }
  }
  context.globalAlpha = 1
}

function editorPoint(event) {
  const canvas = $('#editor-canvas')
  const bounds = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
  }
}

function updateEditorBrushCursor(event = null) {
  if (event) {
    editorState.cursorX = event.clientX
    editorState.cursorY = event.clientY
  }
  const cursor = $('#editor-brush-cursor')
  const canvas = $('#editor-canvas')
  const bounds = canvas.getBoundingClientRect()
  const insideCanvas = editorState.cursorX >= bounds.left && editorState.cursorX <= bounds.right
    && editorState.cursorY >= bounds.top && editorState.cursorY <= bounds.bottom
  if (!editorState.cursorVisible || !editorState.base || !insideCanvas || !bounds.width) {
    cursor.hidden = true
    return
  }
  const diameter = Number($('#brush-size').value) * bounds.width / canvas.width
  const hardness = Number($('#brush-hardness').value) / 100
  const hardCore = hardness ** 1.7
  cursor.hidden = false
  cursor.style.left = `${editorState.cursorX}px`
  cursor.style.top = `${editorState.cursorY}px`
  cursor.style.width = `${diameter}px`
  cursor.style.height = `${diameter}px`
  cursor.dataset.mode = $(`input[name="paint-mode"]:checked`).value
  const inner = $('span', cursor)
  inner.style.width = `${hardCore * 100}%`
  inner.style.height = `${hardCore * 100}%`
  inner.style.opacity = hardCore > 0.015 ? '1' : '0'
}

function editorBrushCharacteristics() {
  const radius = Number($('#brush-size').value) / 2
  const hardness = Number($('#brush-hardness').value) / 100
  return {
    radius,
    hardness,
    hardCore: hardness ** 1.7,
    peakOpacity: 0.28 + 0.72 * hardness ** 0.8,
    spacing: Math.max(1, radius * (0.2 + (1 - hardness) * 0.35)),
  }
}

function paintEditorDab(point) {
  const context = editorState.maskCanvas.getContext('2d', { willReadFrequently: true })
  const { radius, hardness, hardCore, peakOpacity } = editorBrushCharacteristics()
  context.globalCompositeOperation = $(`input[name="paint-mode"]:checked`).value === 'restore'
    ? 'source-over'
    : 'destination-out'
  if (hardness >= 0.999) {
    context.fillStyle = 'rgba(255,255,255,1)'
  } else {
    const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius)
    const shoulder = hardCore + (1 - hardCore) * 0.45
    gradient.addColorStop(0, `rgba(255,255,255,${peakOpacity})`)
    if (hardCore > 0.001) gradient.addColorStop(hardCore, `rgba(255,255,255,${peakOpacity})`)
    gradient.addColorStop(shoulder, `rgba(255,255,255,${peakOpacity * 0.35})`)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
  }
  context.beginPath()
  context.arc(point.x, point.y, radius, 0, Math.PI * 2)
  context.fill()
}

function paintEditorStroke(from, to) {
  const { spacing } = editorBrushCharacteristics()
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance === 0) return
  let traveled = 0
  let distanceToNext = editorState.distanceToNextDab || spacing
  let painted = false
  while (traveled + distanceToNext <= distance) {
    traveled += distanceToNext
    const fraction = traveled / distance
    paintEditorDab({
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
    })
    painted = true
    distanceToNext = spacing
  }
  editorState.distanceToNextDab = distanceToNext - (distance - traveled)
  if (painted) requestEditorRender()
}

function editorMaskSnapshot() {
  return editorState.maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(
    0,
    0,
    editorState.maskCanvas.width,
    editorState.maskCanvas.height,
  )
}

function updateEditorHistoryButtons() {
  $('#editor-undo').disabled = editorState.undo.length === 0
  $('#editor-redo').disabled = editorState.redo.length === 0
}

function restoreEditorSnapshot(from, to) {
  if (!from.length) return
  to.push(editorMaskSnapshot())
  if (to.length > 8) to.shift()
  editorState.maskCanvas.getContext('2d', { willReadFrequently: true }).putImageData(from.pop(), 0, 0)
  updateEditorHistoryButtons()
  requestEditorRender()
}

function setEditorZoom(value) {
  const zoom = Math.max(10, Math.min(1200, Math.round(value)))
  $('#editor-zoom').value = String(zoom)
  $('#editor-zoom-value').textContent = `${zoom}%`
  const canvas = $('#editor-canvas')
  canvas.style.width = `${canvas.width * zoom / 100}px`
  canvas.style.height = `${canvas.height * zoom / 100}px`
  updateEditorBrushCursor()
}

function zoomEditorAt(value, clientX, clientY) {
  const viewport = $('#editor-viewport')
  const canvas = $('#editor-canvas')
  const oldBounds = canvas.getBoundingClientRect()
  if (!oldBounds.width || !oldBounds.height) return
  const insideCanvas = clientX >= oldBounds.left && clientX <= oldBounds.right
    && clientY >= oldBounds.top && clientY <= oldBounds.bottom
  const anchorX = insideCanvas ? clientX : viewport.getBoundingClientRect().left + viewport.clientWidth / 2
  const anchorY = insideCanvas ? clientY : viewport.getBoundingClientRect().top + viewport.clientHeight / 2
  const imageX = (anchorX - oldBounds.left) / oldBounds.width
  const imageY = (anchorY - oldBounds.top) / oldBounds.height
  setEditorZoom(value)
  const newBounds = canvas.getBoundingClientRect()
  viewport.scrollLeft += newBounds.left + imageX * newBounds.width - anchorX
  viewport.scrollTop += newBounds.top + imageY * newBounds.height - anchorY
  updateEditorBrushCursor()
}

function fitEditorCanvas() {
  const viewport = $('#editor-viewport')
  const canvas = $('#editor-canvas')
  if (!canvas.width || !viewport.clientWidth) return
  const scale = Math.min(
    (viewport.clientWidth - 36) / canvas.width,
    (viewport.clientHeight - 54) / canvas.height,
    1,
  )
  setEditorZoom(scale * 100)
}

function exportEditorMask() {
  const canvas = document.createElement('canvas')
  canvas.width = editorState.maskCanvas.width
  canvas.height = editorState.maskCanvas.height
  const context = canvas.getContext('2d')
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(editorState.maskCanvas, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Could not encode the detail mask.')),
    'image/png',
  ))
}

async function saveLayerEditor() {
  if (!editorState.job || !editorState.part) return
  const parentJob = editorState.job
  const part = editorState.part
  const button = $('#save-editor')
  button.disabled = true
  setProcessingState('edit', [part.name], 'Saving detail edit')
  $('#editor-status').textContent = 'Saving mask and preparing the edited PSD…'
  try {
    const mask = await exportEditorMask()
    const body = new FormData()
    body.append('part', part.name)
    body.append('mask', mask, `${part.name}-detail-mask.png`)
    const response = await fetch(`/v1/layer-decompositions/${parentJob.id}/edits`, { method: 'POST', body })
    if (!response.ok) throw new Error(await responseError(response))
    const job = await response.json()
    closeLayerEditor()
    state.jobId = job.id
    history.replaceState({}, '', `?job=${job.id}`)
    $('#job-id').textContent = job.id.slice(0, 12)
    $('#job-progress').hidden = false
    setProgressState('active')
    $('#job-stage').textContent = 'Applying detail edit'
    $('#job-log').textContent = ''
    $('#cancel-job').hidden = false
    $('#cancel-job').disabled = false
    $('#cancel-job').innerHTML = '<i class="icon-square"></i> Stop edit'
    setProcessingState(job.kind, job.replaced_parts, stageLabel(job.stage))
    setStatus(`Building an edited ${formatPartName(part.name)} revision…`)
    $('#job-progress').scrollIntoView({ behavior: 'smooth', block: 'start' })
    pollJob()
  } catch (error) {
    setProcessingState()
    button.disabled = false
    $('#editor-status').textContent = error.message
    showToast(error.message)
  }
}

const editorCanvas = $('#editor-canvas')
editorCanvas.addEventListener('pointerenter', (event) => {
  editorState.cursorVisible = true
  updateEditorBrushCursor(event)
})
editorCanvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !editorState.base) return
  event.preventDefault()
  editorCanvas.setPointerCapture(event.pointerId)
  editorState.undo.push(editorMaskSnapshot())
  if (editorState.undo.length > 8) editorState.undo.shift()
  editorState.redo = []
  updateEditorHistoryButtons()
  editorState.painting = true
  editorState.lastPoint = editorPoint(event)
  editorState.distanceToNextDab = editorBrushCharacteristics().spacing
  paintEditorDab(editorState.lastPoint)
  requestEditorRender()
})
editorCanvas.addEventListener('pointermove', (event) => {
  updateEditorBrushCursor(event)
  if (!editorState.painting) return
  const point = editorPoint(event)
  paintEditorStroke(editorState.lastPoint, point)
  editorState.lastPoint = point
})
function finishEditorStroke() {
  editorState.painting = false
  editorState.lastPoint = null
  editorState.distanceToNextDab = 0
}
editorCanvas.addEventListener('pointerup', finishEditorStroke)
editorCanvas.addEventListener('pointercancel', finishEditorStroke)
editorCanvas.addEventListener('lostpointercapture', finishEditorStroke)
editorCanvas.addEventListener('pointerleave', () => {
  editorState.cursorVisible = false
  updateEditorBrushCursor()
})

$('#editor-undo').addEventListener('click', () => restoreEditorSnapshot(editorState.undo, editorState.redo))
$('#editor-redo').addEventListener('click', () => restoreEditorSnapshot(editorState.redo, editorState.undo))
$('#editor-fit').addEventListener('click', fitEditorCanvas)
$('#editor-zoom').addEventListener('input', (event) => {
  const bounds = $('#editor-viewport').getBoundingClientRect()
  zoomEditorAt(Number(event.target.value), bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
})
$('#brush-size').addEventListener('input', (event) => {
  $('#brush-size-value').textContent = `${event.target.value} px`
  updateEditorBrushCursor()
})
$('#brush-hardness').addEventListener('input', (event) => {
  $('#brush-hardness-value').textContent = `${event.target.value}%`
  updateEditorBrushCursor()
})
$$("input[name='paint-mode']").forEach((input) => input.addEventListener('change', () => updateEditorBrushCursor()))
$('#original-opacity').addEventListener('input', (event) => {
  $('#original-opacity-value').textContent = `${event.target.value}%`
  requestEditorRender()
})
$('#asset-opacity').addEventListener('input', (event) => {
  $('#asset-opacity-value').textContent = `${event.target.value}%`
  requestEditorRender()
})
$('#other-opacity').addEventListener('input', (event) => {
  $('#other-opacity-value').textContent = `${event.target.value}%`
  requestEditorRender()
})
$('#editor-backdrop').addEventListener('change', (event) => {
  const viewport = $('#editor-viewport')
  viewport.dataset.backdrop = event.target.value
  $('#custom-backdrop-field').hidden = event.target.value !== 'custom'
  viewport.style.backgroundColor = event.target.value === 'custom' ? $('#custom-backdrop').value : ''
  viewport.style.backgroundImage = event.target.value === 'custom' ? 'none' : ''
})
$('#custom-backdrop').addEventListener('input', (event) => { $('#editor-viewport').style.backgroundColor = event.target.value })
$('#editor-viewport').addEventListener('wheel', (event) => {
  if (!editorState.base) return
  event.preventDefault()
  let delta = event.deltaY
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= $('#editor-viewport').clientHeight
  const currentZoom = Number($('#editor-zoom').value)
  const factor = Math.exp(-delta * 0.0018)
  let nextZoom = Math.round(currentZoom * factor)
  if (nextZoom === currentZoom && delta !== 0) nextZoom += delta < 0 ? 1 : -1
  zoomEditorAt(nextZoom, event.clientX, event.clientY)
}, { passive: false })
$('#editor-viewport').addEventListener('scroll', () => updateEditorBrushCursor())
$('#save-editor').addEventListener('click', saveLayerEditor)
$('#close-editor').addEventListener('click', closeLayerEditor)
$('#cancel-editor').addEventListener('click', closeLayerEditor)
$('#layer-editor').addEventListener('cancel', (event) => {
  event.preventDefault()
  closeLayerEditor()
})
window.addEventListener('keydown', (event) => {
  if (!$('#layer-editor').open) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    restoreEditorSnapshot(event.shiftKey ? editorState.redo : editorState.undo, event.shiftKey ? editorState.undo : editorState.redo)
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    restoreEditorSnapshot(editorState.redo, editorState.undo)
  } else if (event.key === '[' || event.key === ']') {
    const brush = $('#brush-size')
    brush.value = String(Math.max(2, Math.min(240, Number(brush.value) + (event.key === ']' ? 4 : -4))))
    $('#brush-size-value').textContent = `${brush.value} px`
    updateEditorBrushCursor()
  }
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

async function renderPuppetPreview(job, metadata = null) {
  stopPuppetPreview()
  if (!metadata) metadata = await loadLayerMetadata(job)
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
    previewState.layers.push({ element: image, depth, name, stackProximity: null })
  }
  if (!previewState.layers.length) return
  applyPreviewLayerOrder()

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
    const stackProximity = layer.stackProximity ?? proximity
    layer.element.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,${(stackProximity * 18).toFixed(1)}px) rotate(${rotate.toFixed(3)}deg) scale(1.008)`
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
