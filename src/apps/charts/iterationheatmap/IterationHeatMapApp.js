(function() {
    var Ext = window.Ext4 || window.Ext;

    var progressColors = { //move colors into css file (class would be defined, style would be hex value for light gray in the css )
        'Defined': '#E0E0E0', // light gray
        'In-Progress': '#00A9E0', // cyan
        'Completed': '#8DC63F', // lime
        'problem': '#EF3F35' // red
    };

    Ext.define('Rally.apps.charts.iterationheatmap.IterationHeatMapApp', {
        extend: 'Rally.app.TimeboxScopedApp',
        scopeType: 'iteration',

        componentCls: 'app',

        onScopeChange: function(scope) {

            if (!this.models) {
                this.configureMessageListeners();

                Rally.data.ModelFactory.getModels({
                    types: ['UserStory', 'Defect'],
                    context: this.getContext().getDataContext(),
                    success: function(models) {
                        this.models = models;
                        models.UserStory.getField('ScheduleState').getAllowedValueStore().load({
                            callback: this._createStateMap,
                            scope: this
                        });
                    },
                    scope: this
                });
            } else {
                this._loadArtifacts();
            }
        },

        _createStateMap: function(allowedValues) {
            var stateMap = ['Defined', 'In-Progress', 'Completed'],
                stateMapIndex = 0,
                storyStates = {};

            _.each(allowedValues, function(value) {
                var state = value.data.StringValue;
                if (state) {
                    if (state == stateMap[stateMapIndex + 1]) {
                        stateMapIndex++;
                    }
                    storyStates[state] = stateMap[stateMapIndex];
                }
            });

            this._storyStates = storyStates;
            this._loadArtifacts();
        },

        configureMessageListeners: function() {
            this.subscribe(this, Rally.Message.objectUpdate, function(record) {
                this.beginChartCreation();
            }, this);

            this.subscribe(this, Rally.Message.objectCreate, function(record) {
                this.beginChartCreation();
            }, this);

            this.subscribe(this, Rally.Message.objectDestroy, function(record) {
                this.beginChartCreation();
            }, this);
        },

        _loadArtifacts: function() {
            this._chartData = [];
            this._childChartData = [];
            this._topLevelStore = Ext.create('Rally.data.wsapi.artifact.Store', {
                models: _.values(this.models),
                context: this.getContext().getDataContext(),
                autoLoad: true,
                filters: [
                    this.getContext().getTimeboxScope().getQueryFilter()
                ],
                limit: Infinity,
                fetch: ['FormattedID', 'Name', 'ScheduleState', 'Blocked', 'BlockedReason', 'Defects', 'Tasks', 'PlanEstimate', 'Requirement', 'State'],
                listeners: {
                    load: this._loadChildCollections,
                    scope: this
                }
            });
        },

        _loadChildCollections: function(store, records) {
            var promises = [];
            _.each(records, function(record) {
                if (record.get('Defects') && record.get('Defects').Count) {
                    promises.push(record.getCollection('Defects', {
                        fetch: ['FormattedID', 'Name', 'ScheduleState', 'Blocked', 'BlockedReason', 'Requirement', 'State']
                    }).load({
                            callback: function(defects) {
                                record.get('Defects').Results = defects;
                            }
                        }));
                }

                if (record.get('Tasks') && record.get('Tasks').Count) {
                    promises.push(record.getCollection('Tasks', {
                        fetch: ['FormattedID', 'Name', 'Blocked', 'BlockedReason', 'WorkProduct', 'State']
                    }).load(
                        {
                            callback: function(tasks) {
                                record.get('Tasks').Results = tasks;
                            }
                        }
                    ));
                }
            });

            Deft.Promise.all(promises).then({
                success: this._onAllDataLoaded,
                scope: this,
                failure: function(error) {
                    //error handling?
                }
            });
        },

        _onAllDataLoaded: function(childCollections) {
            _.each(this._topLevelStore.getRange(), function(record) {
                var defects = record.get('Defects'),
                    tasks = record.get('Tasks');
                var defectCount = (defects && defects.Count) || 0;
                var taskCount = record.get('Tasks').Count;
                var count = taskCount + defectCount;
                var planEstimate = record.get('PlanEstimate') || 1;
                var pointSizeForChildren = (planEstimate / count) || 1;

                this._addPointForTopLevelItem(record);

                if(count === 0) {
                    this._childChartData.push(this._addNullPoint('No tasks or defects.', planEstimate));
                } else {
                    if(defects && defects.Results) {
                        _.each(defects.Results, function(defect) {
                            this._addPointForChildItem(defect, record.get('FormattedID'), pointSizeForChildren);
                        }, this);
                    }

                    if(tasks && tasks.Results) {
                        _.each(tasks.Results, function(task) {
                            this._addPointForChildItem(task, record.get('FormattedID'), pointSizeForChildren);
                        }, this);
                    }
                }
            }, this);

            console.log(this._childChartData);

            this._createChart();
        },

        _colorFromStatus: function(state, blocked) { //refactor into css and classes, should get cleaner
            var color =  progressColors[state];
            if(blocked) {
                color = progressColors.problem;
            }
            return color;
        },

        _addPoint: function(name, color, count, rallyName, status, blocked, blockedReason, hasChildren, ref, parentFormattedID){
            //utility class
            return {
                name: name, // FormattedID for chart
                y: count,
                color: color,
                rallyName: rallyName,
                status: status,
                blockedReason: blocked ? blockedReason: null,
                hasChildren: hasChildren,
                ref: ref,
                parentFormattedID: parentFormattedID
            };

        },

        _addNullPoint: function(message, pointSize) {
            return this._addPoint(message, '#FFF', pointSize, null, '', false, null, null, null);
        },

        _addPointForTopLevelItem: function(record) {
            var color = this._colorFromStatus(this._storyStates[record.get('ScheduleState')], record.get('Blocked')),
                pointSize = record.get('PlanEstimate') || 1,
                state = record.get('ScheduleState'),
                hasChildren = (record.get('Defects') && record.get('Defects').Count || 0) + record.get('Tasks').Count > 0;

            this._chartData.push(this._addPoint(record.get('FormattedID'), color, pointSize, record.get('Name'), state, record.get('Blocked'), record.get('BlockedReason'), hasChildren, record.get('_ref')));
        },
        
        _addPointForChildItem: function(record, parentFormattedID, pointSize) {
            var state = record.get('ScheduleState') || record.get('State');
            var color = this._colorFromStatus(this._storyStates[state], record.get('Blocked'));

            this._childChartData.push(this._addPoint(record.get('FormattedID'), color, pointSize, record.get('Name'), state, record.get('Blocked'), record.get('BlockedReason'), false, record.get('_ref'), parentFormattedID));
        },

        _createChart: function() {
            this.add({
                id: 'piHeatmapChart',
                xtype: 'rallychart',
                chartData: {
                    series: [
                        {
                            type:'pie',
                            name: 'Children',
                            data: this._chartData,
                            size: '60%',
                            dataLabels:
                            {
                                distance: -10,
                                color: 'black',
                                style: {
                                    fontWeight: 'bold'
                                }
                            }
                        },
                        {
                            type:'pie',
                            name: 'Grand Children',
                            data: this._childChartData,
                            size: '80%',
                            innerSize: '60%',
                            dataLabels: { enabled: false }
                        }
                    ]
                },

                chartConfig: {
                    chart: {
                        type: 'pie',
                        width: this.getSize().width,
                        height: this.getSize().height
                    },
                    xAxis: { categories : []},
                    tooltip: {
                        formatter:  this._formatTooltip,
                        valuePrefix: 'Count: '

                    },
                    title: {
                        text: this.getContext().getTimeboxScope().getRecord().get('Name')
                    },
                    yAxis: {
                        title: {
                            text: 'Progress'
                        }
                    },
                    plotOptions: {
                        pie: {
                            shadow: false,
                            center: ['50%', '50%'],
                            point: {
                                events: {
                                    click: function(event) {
                                        Rally.nav.Manager.showDetail(this.ref);
                                    }
                                }
                            }
                        }
                    }
                }
            });
            /*scope.add(chart);
             chart.getEl().unmask(); //is this needed?
             scope.setLoading( false );*/
        },

        formatTooltip: function() {
            var storyCount = '';
            if(!this.point.userStory) {
                var numStories = this.point.hasChildren ? this.y : 0;
                storyCount = '<br/>Children: ' + numStories;
            }
            var blockedReason = '';
            if(this.point.blockedReason) {
                blockedReason = '<b>Blocked</b>: ' + this.point.blockedReason;
            }
            var artifactName = this.point.rallyName ? '<b>' + this.point.name + '</b>: ' + this.point.rallyName + '<br/>' : this.point.name; //change this so that it works if rallyName is null
            return artifactName + this.point.status + '<br/>' + storyCount + '<br/>' + blockedReason;
        }
    });
})();

