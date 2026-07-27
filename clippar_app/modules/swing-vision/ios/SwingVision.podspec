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
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'Vision', 'AVFoundation', 'CoreML', 'CoreImage'

  # The MobileCLIP2 image encoder (.mlpackage → compiled to .mlmodelc at build)
  # and the baked class text embeddings, bundled as a resource bundle so we can
  # locate them at runtime regardless of static-framework packaging.
  s.resource_bundles = {
    'SwingVisionResources' => ['MobileCLIP2S2Image.mlpackage', 'class_text_embeddings.json']
  }
end
