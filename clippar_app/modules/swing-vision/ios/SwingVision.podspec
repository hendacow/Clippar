require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SwingVision'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # 14.0 (matches shot-detector) so this module never raises the whole app's
  # install floor. The Core ML MODEL is compiled for iOS 16, so it simply fails
  # to load on iOS 15 (feature hides gracefully via isAvailable()); it does not
  # block install or force an OS update.
  s.platforms      = { :ios => '14.0' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'Vision', 'AVFoundation', 'CoreML', 'CoreImage'

  # The MobileCLIP2 image encoder (.mlpackage — CocoaPods copies it verbatim, so
  # the module compiles it to .mlmodelc on first launch) plus the baked IMAGE
  # prototypes. The prototypes replace the old class_text_embeddings.json: text
  # prompts were measured losing to image prototypes badly enough to reject a
  # textbook bunker swing. ~34 KB against a 69 MB model.
  s.resource_bundles = {
    'SwingVisionResources' => ['MobileCLIP2S2Image.mlpackage', 'swing_prototypes.json']
  }
end
