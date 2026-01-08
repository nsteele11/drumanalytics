/**
 * Performance Analysis System for Drum Videos
 * 
 * Analyzes small datasets (n ≤ 15) to surface directional signals
 * relating video metadata to performance (views & likes), without
 * claiming statistical certainty.
 */

/**
 * Step 1: Standardize & Derive Metrics
 * Generates derived fields for every video
 */
function standardizeAndDeriveMetrics(videos) {
  // Filter videos that have platform and metrics data
  const videosWithMetrics = videos.filter(v => {
    const hasIg = v.igViews !== null && v.igViews !== undefined && 
                  v.igLikes !== null && v.igLikes !== undefined;
    const hasTiktok = v.tiktokViews !== null && v.tiktokViews !== undefined && 
                      v.tiktokLikes !== null && v.tiktokLikes !== undefined;
    return hasIg || hasTiktok;
  });

  if (videosWithMetrics.length === 0) {
    return [];
  }

  // Calculate platform medians
  const igVideos = videosWithMetrics.filter(v => 
    v.igViews !== null && v.igViews !== undefined &&
    v.igLikes !== null && v.igLikes !== undefined
  );
  const tiktokVideos = videosWithMetrics.filter(v => 
    v.tiktokViews !== null && v.tiktokViews !== undefined &&
    v.tiktokLikes !== null && v.tiktokLikes !== undefined
  );

  const igViewsValues = igVideos.map(v => v.igViews).filter(v => v > 0);
  const igLikesValues = igVideos.map(v => v.igLikes).filter(v => v > 0);
  const tiktokViewsValues = tiktokVideos.map(v => v.tiktokViews).filter(v => v > 0);
  const tiktokLikesValues = tiktokVideos.map(v => v.tiktokLikes).filter(v => v > 0);

  const igViewsMedian = calculateMedian(igViewsValues);
  const igLikesMedian = calculateMedian(igLikesValues);
  const tiktokViewsMedian = calculateMedian(tiktokViewsValues);
  const tiktokLikesMedian = calculateMedian(tiktokLikesValues);

  // Process each video to add derived metrics
  const processedVideos = videosWithMetrics.map(video => {
    const processed = { ...video };

    // Determine platform and get appropriate metrics
    let platform = null;
    let views = null;
    let likes = null;
    let viewsMedian = null;
    let likesMedian = null;

    // Prefer the platform with data, or use IG if both exist
    if (video.igViews !== null && video.igViews !== undefined) {
      platform = 'instagram';
      views = video.igViews;
      likes = video.igLikes || 0;
      viewsMedian = igViewsMedian;
      likesMedian = igLikesMedian;
    } else if (video.tiktokViews !== null && video.tiktokViews !== undefined) {
      platform = 'tiktok';
      views = video.tiktokViews;
      likes = video.tiktokLikes || 0;
      viewsMedian = tiktokViewsMedian;
      likesMedian = tiktokLikesMedian;
    }

    if (platform && views !== null && views !== undefined && viewsMedian && viewsMedian > 0) {
      // Engagement proxy
      processed.engagement_proxy = views > 0 ? likes / views : 0;

      // Platform-normalized metrics
      processed.views_relative = views / viewsMedian;
      processed.likes_relative = likesMedian > 0 ? likes / likesMedian : 0;

      // Binary performance labels
      processed.high_view = views > viewsMedian;
      processed.high_like = likesMedian > 0 ? likes > likesMedian : false;

      processed.platform = platform;
      processed.views = views;
      processed.likes = likes;
    } else {
      processed.engagement_proxy = 0;
      processed.views_relative = 0;
      processed.likes_relative = 0;
      processed.high_view = false;
      processed.high_like = false;
      processed.platform = platform;
      processed.views = views || 0;
      processed.likes = likes || 0;
    }

    return processed;
  });

  // Calculate performance ranks after all videos are processed
  const viewsRank = calculateRanks(processedVideos, 'views', true);
  const likesRank = calculateRanks(processedVideos, 'likes', true);
  const engagementRank = calculateRanks(processedVideos, 'engagement_proxy', true);

  // Add performance rank to each video
  processedVideos.forEach((video, idx) => {
    video.performance_rank = (viewsRank[idx] + likesRank[idx] + engagementRank[idx]) / 3;
  });

  return processedVideos;
}

/**
 * Step 2: Metadata Classifications
 * Classifies metadata fields into usable categories
 */
function classifyMetadata(video) {
  const classifications = {};

  // Day of week from postedDate
  if (video.postedDate) {
    try {
      const date = new Date(video.postedDate);
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayOfWeek = dayNames[date.getDay()];
      classifications.day_of_week = dayOfWeek;
      classifications.is_weekend = dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday';
    } catch (e) {
      classifications.day_of_week = null;
      classifications.is_weekend = null;
    }
  }

  // Video type (categorical)
  if (video.videoType) {
    classifications.video_type = video.videoType;
  }

  // Duration buckets (numeric → categorical)
  if (video.duration !== null && video.duration !== undefined) {
    const durationSeconds = video.duration;
    if (durationSeconds < 15) {
      classifications.video_length_bucket = '<15s';
    } else if (durationSeconds <= 30) {
      classifications.video_length_bucket = '15–30s';
    } else if (durationSeconds <= 60) {
      classifications.video_length_bucket = '30–60s';
    } else {
      classifications.video_length_bucket = '>60s';
    }
  }

  // BPM classification (numeric → categorical)
  if (video.bpm !== null && video.bpm !== undefined) {
    if (video.bpm < 100) {
      classifications.bpm_bucket = '<100';
    } else if (video.bpm <= 120) {
      classifications.bpm_bucket = '100–120';
    } else if (video.bpm <= 140) {
      classifications.bpm_bucket = '120–140';
    } else {
      classifications.bpm_bucket = '>140';
    }
  }

  // Energy classification (boolean/categorical)
  if (video.energy !== null && video.energy !== undefined) {
    if (video.energy < 0.3) {
      classifications.energy_level = 'low';
    } else if (video.energy <= 0.6) {
      classifications.energy_level = 'medium';
    } else {
      classifications.energy_level = 'high';
    }
  }

  // Genre classification (categorical)
  if (video.genres && Array.isArray(video.genres) && video.genres.length > 0) {
    classifications.primary_genre = video.genres[0];
    classifications.has_genre = true;
  } else {
    classifications.has_genre = false;
  }

  // Artist popularity (numeric → categorical)
  if (video.artistFollowers !== null && video.artistFollowers !== undefined) {
    if (video.artistFollowers < 10000) {
      classifications.artist_size = 'small';
    } else if (video.artistFollowers <= 100000) {
      classifications.artist_size = 'medium';
    } else {
      classifications.artist_size = 'large';
    }
  }

  // Track popularity (numeric → categorical)
  if (video.popularity !== null && video.popularity !== undefined) {
    if (video.popularity < 40) {
      classifications.track_popularity = 'low';
    } else if (video.popularity <= 60) {
      classifications.track_popularity = 'medium';
    } else {
      classifications.track_popularity = 'high';
    }
  }

  // Hashtag presence (boolean)
  classifications.has_ig_hashtags = !!(video.igHashtags && video.igHashtags.trim().length > 0);
  classifications.has_tiktok_hashtags = !!(video.tiktokHashtags && video.tiktokHashtags.trim().length > 0);

  return classifications;
}

/**
 * Step 3A: Lift Analysis
 * Computes lift for each metadata value
 */
function computeLiftAnalysis(videos) {
  const processedVideos = videos.filter(v => v.views !== null && v.views !== undefined);

  if (processedVideos.length === 0) {
    return [];
  }

  // Global probabilities
  const highViewCount = processedVideos.filter(v => v.high_view).length;
  const highLikeCount = processedVideos.filter(v => v.high_like).length;
  const totalCount = processedVideos.length;

  const pHighView = highViewCount / totalCount;
  const pHighLike = highLikeCount / totalCount;

  // Extract all unique metadata features
  const featureValueMap = new Map();

  processedVideos.forEach(video => {
    const classifications = classifyMetadata(video);
    
    Object.entries(classifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      
      const key = `${feature}:${value}`;
      if (!featureValueMap.has(key)) {
        featureValueMap.set(key, {
          feature,
          value: String(value),
          videos: []
        });
      }
      featureValueMap.get(key).videos.push(video);
    });
  });

  // Calculate lift for each feature-value combination
  const liftResults = [];

  featureValueMap.forEach(({ feature, value, videos: featureVideos }) => {
    // Only report if feature appears in ≥2 videos
    if (featureVideos.length < 2) return;

    const featureHighViewCount = featureVideos.filter(v => v.high_view).length;
    const featureHighLikeCount = featureVideos.filter(v => v.high_like).length;
    const featureCount = featureVideos.length;

    const pHighViewGivenFeature = featureHighViewCount / featureCount;
    const pHighLikeGivenFeature = featureHighLikeCount / featureCount;

    const liftViews = pHighView > 0 ? pHighViewGivenFeature / pHighView : 0;
    const liftLikes = pHighLike > 0 ? pHighLikeGivenFeature / pHighLike : 0;

    liftResults.push({
      feature,
      value,
      sample_size: featureCount,
      lift_views: Math.round(liftViews * 100) / 100,
      lift_likes: Math.round(liftLikes * 100) / 100,
      confidence: 'early'
    });
  });

  return liftResults.sort((a, b) => {
    // Sort by highest average lift
    const avgLiftA = (a.lift_views + a.lift_likes) / 2;
    const avgLiftB = (b.lift_views + b.lift_likes) / 2;
    return avgLiftB - avgLiftA;
  });
}

/**
 * Step 3B: Rank Association
 * For each metadata value, compute average performance rank
 */
function computeRankAssociation(videos) {
  const processedVideos = videos.filter(v => v.performance_rank !== null && v.performance_rank !== undefined);

  if (processedVideos.length === 0) {
    return [];
  }

  const globalMedianRank = calculateMedian(processedVideos.map(v => v.performance_rank));

  const featureValueMap = new Map();

  processedVideos.forEach(video => {
    const classifications = classifyMetadata(video);
    
    Object.entries(classifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      
      const key = `${feature}:${value}`;
      if (!featureValueMap.has(key)) {
        featureValueMap.set(key, {
          feature,
          value: String(value),
          ranks: []
        });
      }
      featureValueMap.get(key).ranks.push(video.performance_rank);
    });
  });

  const rankResults = [];

  featureValueMap.forEach(({ feature, value, ranks }) => {
    if (ranks.length < 2) return; // Only report if appears in ≥2 videos

    const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const vsMedian = avgRank - globalMedianRank;

    rankResults.push({
      feature,
      value,
      sample_size: ranks.length,
      avg_rank: Math.round(avgRank * 100) / 100,
      vs_median_rank: Math.round(vsMedian * 100) / 100,
      confidence: 'early'
    });
  });

  return rankResults.sort((a, b) => b.avg_rank - a.avg_rank); // Sort by highest rank
}

/**
 * Step 3C: Distribution Summary
 * For each metadata feature, compute distribution stats
 */
function computeDistributionSummary(videos) {
  const processedVideos = videos.filter(v => v.views_relative !== null && v.views_relative !== undefined);

  if (processedVideos.length === 0) {
    return [];
  }

  const featureMap = new Map();

  processedVideos.forEach(video => {
    const classifications = classifyMetadata(video);
    
    Object.entries(classifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      
      if (!featureMap.has(feature)) {
        featureMap.set(feature, []);
      }
      featureMap.get(feature).push({
        value: String(value),
        views_relative: video.views_relative,
        engagement_proxy: video.engagement_proxy
      });
    });
  });

  const distributionResults = [];

  featureMap.forEach((values, feature) => {
    // Group by value
    const valueGroups = new Map();
    values.forEach(({ value, views_relative, engagement_proxy }) => {
      if (!valueGroups.has(value)) {
        valueGroups.set(value, {
          views_relative: [],
          engagement_proxy: []
        });
      }
      valueGroups.get(value).views_relative.push(views_relative);
      valueGroups.get(value).engagement_proxy.push(engagement_proxy);
    });

    valueGroups.forEach(({ views_relative: vr, engagement_proxy: ep }, value) => {
      if (vr.length < 2) return; // Only report if appears in ≥2 videos

      const medianViewsRelative = calculateMedian(vr);
      const medianEngagementProxy = calculateMedian(ep);

      distributionResults.push({
        feature,
        value,
        count: vr.length,
        median_views_relative: Math.round(medianViewsRelative * 100) / 100,
        median_engagement_proxy: Math.round(medianEngagementProxy * 1000) / 1000
      });
    });
  });

  return distributionResults.sort((a, b) => b.median_views_relative - a.median_views_relative);
}

/**
 * Step 4: Generate Structured Outputs
 */
function generateStructuredOutputs(videos) {
  const processedVideos = standardizeAndDeriveMetrics(videos);
  
  if (processedVideos.length === 0) {
    return {
      error: 'No videos with performance metrics found',
      early_signal_summary: [],
      what_seems_working: [],
      per_video_comparison: []
    };
  }

  // Add metadata classifications to processed videos
  processedVideos.forEach(video => {
    Object.assign(video, classifyMetadata(video));
  });

  // Step 3 analyses
  const liftAnalysis = computeLiftAnalysis(processedVideos);
  const rankAssociation = computeRankAssociation(processedVideos);
  const distributionSummary = computeDistributionSummary(processedVideos);

  // 1. Early Signal Summary (from lift analysis)
  const earlySignalSummary = liftAnalysis.map(lift => ({
    feature: lift.feature,
    value: lift.value,
    sample_size: lift.sample_size,
    lift_views: lift.lift_views,
    lift_likes: lift.lift_likes,
    confidence: lift.confidence
  }));

  // 2. "What Seems to Be Working" List
  // Rank by highest lift and consistency (appears in multiple top-ranked videos)
  const top30Percent = Math.ceil(processedVideos.length * 0.3);
  const topVideos = processedVideos
    .sort((a, b) => b.performance_rank - a.performance_rank)
    .slice(0, top30Percent);

  const featureCountsInTopVideos = new Map();
  topVideos.forEach(video => {
    const classifications = classifyMetadata(video);
    Object.entries(classifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      const key = `${feature}:${value}`;
      featureCountsInTopVideos.set(key, (featureCountsInTopVideos.get(key) || 0) + 1);
    });
  });

  const whatSeemsWorking = liftAnalysis.map(lift => {
    const key = `${lift.feature}:${lift.value}`;
    const appearancesInTopVideos = featureCountsInTopVideos.get(key) || 0;
    const consistencyScore = appearancesInTopVideos / top30Percent;

    return {
      feature: lift.feature,
      value: lift.value,
      lift_views: lift.lift_views,
      lift_likes: lift.lift_likes,
      appearances_in_top_30_percent: appearancesInTopVideos,
      consistency_score: Math.round(consistencyScore * 100) / 100,
      sample_size: lift.sample_size
    };
  })
  .filter(item => item.lift_views > 1 || item.lift_likes > 1) // Only positive lift
  .sort((a, b) => {
    // Sort by average lift, then by consistency
    const avgLiftA = (a.lift_views + a.lift_likes) / 2;
    const avgLiftB = (b.lift_views + b.lift_likes) / 2;
    if (Math.abs(avgLiftA - avgLiftB) < 0.01) {
      return b.consistency_score - a.consistency_score;
    }
    return avgLiftB - avgLiftA;
  });

  // 3. Per-Video Comparison Object
  const topVideoClassifications = new Map();
  topVideos.forEach(video => {
    const classifications = classifyMetadata(video);
    Object.entries(classifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      const key = `${feature}:${value}`;
      topVideoClassifications.set(key, (topVideoClassifications.get(key) || 0) + 1);
    });
  });

  const perVideoComparison = processedVideos.map(video => {
    const videoClassifications = classifyMetadata(video);
    const overlapTraits = [];
    const uniqueTraits = [];

    Object.entries(videoClassifications).forEach(([feature, value]) => {
      if (value === null || value === undefined) return;
      const key = `${feature}:${value}`;
      if (topVideoClassifications.has(key)) {
        overlapTraits.push({ feature, value });
      } else {
        uniqueTraits.push({ feature, value });
      }
    });

    return {
      s3Key: video.s3Key,
      trackName: video.trackName || 'Unknown',
      artistName: video.artistName || 'Unknown',
      platform: video.platform || 'unknown',
      views: video.views || 0,
      likes: video.likes || 0,
      engagement_proxy: Math.round((video.engagement_proxy || 0) * 1000) / 1000,
      performance_rank: Math.round((video.performance_rank || 0) * 100) / 100,
      metadata_overlap_with_top_30_percent: {
        overlap_count: overlapTraits.length,
        traits: overlapTraits
      },
      unique_traits: uniqueTraits
    };
  })
  .sort((a, b) => b.performance_rank - a.performance_rank);

  return {
    analysis_metadata: {
      total_videos: processedVideos.length,
      videos_with_metrics: processedVideos.length,
      analysis_date: new Date().toISOString(),
      confidence_level: 'early_signal'
    },
    early_signal_summary: earlySignalSummary,
    what_seems_working: whatSeemsWorking,
    per_video_comparison: perVideoComparison,
    rank_association: rankAssociation,
    distribution_summary: distributionSummary
  };
}

// Helper Functions

function calculateMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function calculateRanks(videos, field, descending = true) {
  const indexed = videos.map((v, i) => ({ value: v[field] || 0, index: i }));
  indexed.sort((a, b) => descending ? b.value - a.value : a.value - b.value);
  
  const ranks = new Array(videos.length);
  indexed.forEach((item, rank) => {
    ranks[item.index] = rank + 1;
  });
  
  return ranks;
}

export {
  standardizeAndDeriveMetrics,
  classifyMetadata,
  computeLiftAnalysis,
  computeRankAssociation,
  computeDistributionSummary,
  generateStructuredOutputs
};

