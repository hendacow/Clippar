require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ShotDetector'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '14.0' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'Vision', 'AVFoundation', 'Accelerate', 'CoreML'

  # Tracer V3's golf-ball model (the lab's golfballyolov8n exported at 640, 5.9 MB FP16).
  # CocoaPods copies a .mlpackage VERBATIM rather than compiling it, so TracerDetect.swift
  # compiles it to .mlmodelc once at first use and caches the result — the same pattern as
  # SwingVision next door. Loading is lazy, so with config.tracer.enabled off it never happens.
  s.resource_bundles = { 'ShotDetectorResources' => ['GolfBallDetector.mlpackage'] }
end
